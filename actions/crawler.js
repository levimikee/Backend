// actions/crawler.js

const axios = require('axios');
const cheerio = require('cheerio');
const { generateUpdatesObject, formatString, formatUrl, formatEmail } = require('../utils');
const { columnMappings, maximumParallelLoops, maximumRelativesToCrawl } = require('../config');
const { mapLimit, sleep } = require('modern-async');
const OpenAI = require('openai');
const { notifySlack } = require('./slack');

const openai = new OpenAI({ apiKey: process.env.OPENAI_KEY });

/**
 * Normaliza una dirección quitando espacios, caracteres especiales y palabras comunes.
 */
function normalizeAddress(address) {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]/gi, '')   // elimina espacios, comas, etc.
    .replace(/\bapt\b/g, '')      // quita 'apt'
    .replace(/\bs\b/g, '')        // quita 's'
    .replace(/\bave\b/g, '')      // quita 'ave'
    .replace(/\besplanade\b/g, '') // opcional, más laxo
    .trim();
}

class Crawler {
  constructor() {
    // Instancia para scrapingBee
    this.axiosInstance = axios.create({
      baseURL: 'https://app.scrapingbee.com/api/v1'
    });

    // Instancia para BizFile (California SOS)
    this.axiosBizFileInstance = axios.create({
      baseURL: 'https://bizfileonline.sos.ca.gov',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'undefined',
        'User-Agent': 'PostmanRuntime/7.28.4',
        'Host': ''
      }
    });

    this.requestCount = 0;
  }

  /**
   * Verifica si un string coincide con el patrón de teléfono válido (e.g. "(818) 216-1919").
   */
  isValidPhone(phone) {
    return /^\(\d{3}\)\s?\d{3}-\d{4}$/.test(phone);
  }

  /**
   * Consulta a OpenAI si un teléfono es Wireless (W), Landline (L) o Unknown (U).
   * Devuelve la letra "W", "L" o "U".
   */
  async checkPhoneType(phoneNumber) {
    const prompt = `Is the phone number "${phoneNumber}" a wireless/mobile or landline number in the United States? Reply only with "W" for wireless or "L" for landline.`;
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          { role: 'system', content: 'You are an assistant that knows whether a US phone number is wireless (mobile) or landline. Only answer "W" or "L".' },
          { role: 'user', content: prompt }
        ],
        temperature: 0
      });
      const type = response.choices[0]?.message?.content?.trim().toUpperCase();
      return (type === 'W' || type === 'L') ? type : 'U';
    } catch (error) {
      console.error(`Error determining phone type for ${phoneNumber}:`, error.message);
      return 'U';
    }
  }

  /**
   * Etiqueta un array de strings que contienen teléfonos en su formato "(###) ###-####"
   * y devuelve un array de objetos { number: "(###) ###-####", type: "W"|"L"|"U" } sin duplicados.
   */
  async labelPhoneNumbers(phoneNumbers) {
    const seen = new Set();
    const result = [];
    for (const raw of phoneNumbers) {
      const phone = raw.trim();
      if (seen.has(phone)) continue;
      seen.add(phone);

      let type = 'U';
      if (this.isValidPhone(phone)) {
        type = await this.checkPhoneType(phone); // "W", "L" o "U"
      }
      result.push({ number: phone, type });
    }
    return result;
  }

  /**
   * Compara dos direcciones o nombres a través de OpenAI, devuelve true|false.
   */
  async addressesMatchUsingAI(a, b) {
    const prompt = `Do "${a}" and "${b}" refer to the same person or address? Reply only with true or false.`;
    try {
      const res = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are an assistant that compares two names or addresses. Only respond with "true" or "false".' },
          { role: 'user', content: prompt }
        ],
        temperature: 0
      });
      return res.choices[0]?.message?.content?.trim().toLowerCase() === 'true';
    } catch (err) {
      console.error("🧠 Error comparing via OpenAI:", err.message);
      return false;
    }
  }

  /**
   * Obtiene el HTML renderizado de una URL usando ScrapingBee.
   * Devuelve el body completo (en texto) o string vacío si falló.
   */
  async getHtmlContent(url) {
    let result = "";
    try {
      const response = await this.axiosInstance.get("", {
        params: {
          api_key: process.env.APIKEY,
          url: url,
          render_js: true,
          wait: 5000
        },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      this.requestCount++;
      result = response.data;
      notifySlack(`✅ Scraping exitoso: ${url}`);
      // Espera aleatoria entre 4 y 7 segundos antes de la siguiente request
      await sleep(Math.floor(Math.random() * 3000) + 4000);
    } catch (error) {
      notifySlack(`❌ Error al obtener HTML: ${url} - ${error.message}`);
      console.error("❌ Error:", {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data?.slice?.(0, 200)
      });
      await sleep(3000);
    } finally {
      return result;
    }
  }

  /**
   * Busca por dirección postal y devuelve todos los teléfonos, parientes y asociados encontrados.
   * @param {string} address
   * @param {string} city
   * @param {string} state
   * @param {object} ownerDetails  Contiene ownerOneFirstName, ownerOneLastName, ownerTwoFirstName, ownerTwoLastName
   * @returns {object} { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails }
   */
  async searchByAddress(address, city, state, ownerDetails) {
    try {
      let currentPage = 1;
      let allPhoneNumbers = [];
      let isUserMatched = false;
      let allRelatives = [], allAssociates = [], allRelativeNames = [], allAssociateNames = [], allEmails = [];

      while (true) {
        const formattedAddress = formatString(address);
        const formattedCity = formatString(city);
        const formattedState = formatString(state);
        const url = `https://www.cyberbackgroundchecks.com/address/${formattedAddress}/${formattedCity}/${formattedState}/${currentPage}`;

        console.log(`Crawling page no ${currentPage}, URL: ${url}`);
        const html = await this.getHtmlContent(url);

        // Verifica si el usuario existe; extrae su URL de perfil y teléfonos de la tarjeta
        const { profileURL, isMatchfound, cardPhoneNumbers } = await this.getDetailsProfileURL(ownerDetails, html, address);
        isUserMatched = isUserMatched || isMatchfound;
        if (cardPhoneNumbers) allPhoneNumbers.push(...cardPhoneNumbers);

        if (isUserMatched) {
          // Si halló al usuario, procesamos su perfil y agregamos detalles
          const processedData = await this.processUserMatched(
            profileURL,
            allPhoneNumbers,
            allRelatives,
            allAssociates,
            allRelativeNames,
            allAssociateNames,
            allEmails
          );
          ({
            allPhoneNumbers,
            allRelatives,
            allAssociates,
            allRelativeNames,
            allAssociateNames,
            allEmails
          } = processedData);
        }

        // Verifica si hay siguiente página
        const nextPageAvailable = await this.checkIfNextPageExists(html);
        if (!nextPageAvailable) break;
        currentPage++;
      }

      return { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails };
    } catch (error) {
      console.error(`Error searching user by address: ${address}:`, error);
      return {
        allPhoneNumbers: [],
        isUserMatched: false,
        allRelatives: [],
        allAssociates: [],
        allRelativeNames: [],
        allAssociateNames: [],
        allEmails: []
      };
    }
  }

  /**
   * Busca por nombre y devuelve todos los teléfonos, parientes y asociados encontrados.
   * @param {string} name
   * @param {string} propertyAddress
   * @param {string} address
   * @param {string} city
   * @param {string} state
   * @returns {object} { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails }
   */
  async searchByName(name, propertyAddress, address, city, state) {
    try {
      let currentPage = 1;
      let allPhoneNumbers = [];
      let isUserMatched = false;
      let allRelatives = [], allAssociates = [], allRelativeNames = [], allAssociateNames = [], allEmails = [];

      while (true) {
        const formattedName = formatString(name);
        const formattedCity = formatString(city);
        const formattedState = formatString(state);
        const url = `https://www.cyberbackgroundchecks.com/people/${formattedName}/${formattedState}/${formattedCity}/${currentPage}`;

        console.log(`Crawling page no ${currentPage}, URL: ${url}`);
        const html = await this.getHtmlContent(url);

        // Verifica si el usuario existe; obtenemos URL de perfil y teléfonos de la tarjeta
        const { profileURL, isMatchfound, cardPhoneNumbers } = await this.getDetailsProfileURLByAddress(
          address,
          propertyAddress,
          html
        );
        isUserMatched = isUserMatched || isMatchfound;
        if (cardPhoneNumbers) allPhoneNumbers.push(...cardPhoneNumbers);

        if (isUserMatched) {
          const processedData = await this.processUserMatched(
            profileURL,
            allPhoneNumbers,
            allRelatives,
            allAssociates,
            allRelativeNames,
            allAssociateNames,
            allEmails
          );
          ({
            allPhoneNumbers,
            allRelatives,
            allAssociates,
            allRelativeNames,
            allAssociateNames,
            allEmails
          } = processedData);
        }

        const nextPageAvailable = await this.checkIfNextPageExists(html);
        if (!nextPageAvailable) break;
        currentPage++;
      }

      return { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails };
    } catch (error) {
      console.error("Error searching user by name:", error);
      return {
        allPhoneNumbers: [],
        isUserMatched: false,
        allRelatives: [],
        allAssociates: [],
        allRelativeNames: [],
        allAssociateNames: [],
        allEmails: []
      };
    }
  }

  /**
   * Si se encuentra un match por nombre dentro de las tarjetas,
   * extrae la URL de perfil y los teléfonos desde el script de ld+json.
   * @param {object} ownerDetails  Contiene ownerOneFirstName, ownerOneLastName, ownerTwoFirstName, ownerTwoLastName
   * @param {string} htmlContent
   * @param {string} address  Dirección para comparar si no hay nombre completo
   */
  async getDetailsProfileURL(ownerDetails, htmlContent, address) {
    try {
      let profileURL = '';
      let isMatchfound = false;
      let cardPhoneNumbers = [];

      const $ = cheerio.load(htmlContent);
      const cardList = $('.card');

      // Función auxiliar para extraer teléfonos de una tarjeta
      function pushPhone(phoneElements) {
        phoneElements.each((index, element) => {
          const phoneNumber = $(element).text().trim();
          if (phoneNumber) cardPhoneNumbers.push(phoneNumber);
        });
      }

      for (let index = 0; index < cardList.length; index++) {
        const card = cardList.eq(index);
        const nameGiven = card.find('.name-given');
        const phoneNumbers = card.find('.phone');

        if (nameGiven.length > 0) {
          const cardFullName = nameGiven.text().trim();
          const ownerOneFullName = `${ownerDetails.ownerOneFirstName} ${ownerDetails.ownerOneLastName}`;
          const ownerTwoFullName = `${ownerDetails.ownerTwoFirstName} ${ownerDetails.ownerTwoLastName}`;
          const cardAddress = card.find('.address-current').text().trim();

          // Coincidencia exacta por nombre completo
          if (
            (ownerOneFullName.length && cardFullName === ownerOneFullName) ||
            (ownerTwoFullName.length && cardFullName === ownerTwoFullName)
          ) {
            isMatchfound = true;
            profileURL = card.find('[title*="View full"]').attr('href');
            pushPhone(phoneNumbers);
            return { profileURL, isMatchfound, cardPhoneNumbers };
          }
          // Coincidencia parcial (contiene nombre y apellido)
          else if (
            (
              ownerDetails.ownerOneFirstName?.length &&
              ownerDetails.ownerOneLastName?.length &&
              cardFullName.includes(ownerDetails.ownerOneFirstName) &&
              cardFullName.includes(ownerDetails.ownerOneLastName)
            ) ||
            (
              ownerDetails.ownerTwoFirstName?.length &&
              ownerDetails.ownerTwoLastName?.length &&
              cardFullName.includes(ownerDetails.ownerTwoFirstName) &&
              cardFullName.includes(ownerDetails.ownerTwoLastName)
            )
          ) {
            isMatchfound = true;
            profileURL = card.find('[title*="View full"]').attr('href');
            pushPhone(phoneNumbers);
            return { profileURL, isMatchfound, cardPhoneNumbers };
          }
          // Coincidencia por apellido + dirección (si no hay nombre)
          else if (
            (
              !ownerDetails.ownerOneFirstName?.length &&
              ownerDetails.ownerOneLastName?.length &&
              cardFullName.includes(ownerDetails.ownerOneLastName) &&
              cardAddress.includes(address)
            ) ||
            (
              !ownerDetails.ownerTwoFirstName?.length &&
              ownerDetails.ownerTwoLastName?.length &&
              cardFullName.includes(ownerDetails.ownerTwoLastName) &&
              cardAddress.includes(address)
            )
          ) {
            isMatchfound = true;
            profileURL = card.find('[title*="View full"]').attr('href');
            pushPhone(phoneNumbers);
            return { profileURL, isMatchfound, cardPhoneNumbers };
          }
        }
      }
    } catch (error) {
      console.error(`Error extracting profile URL`, error);
    }

    // Si no encontró ningún match:
    return { profileURL: '', isMatchfound: false, cardPhoneNumbers: [] };
  }

  /**
   * Similar a getDetailsProfileURL, pero compara usando dirección/propiedad primero.
   * @param {string} mailingAddress
   * @param {string} propertyAddress
   * @param {string} htmlContent
   */
  async getDetailsProfileURLByAddress(mailingAddress, propertyAddress, htmlContent) {
    try {
      let profileURL = '';
      let isMatchfound = false;
      const cardPhoneNumbers = [];

      const data = this.extractDataFromLdJson(htmlContent);
      if (data) {
        const { telephones, addresses, profileURL: extractedUrl } = data;
        const targetAddresses = [mailingAddress, propertyAddress].map(a => a?.toLowerCase().trim());

        const matchFound = addresses?.some(addr => {
          const full = addr.full?.toLowerCase() || '';
          return targetAddresses.some(target =>
            full.includes(target) ||
            full.replace(/[^a-z0-9]/gi, '').includes(target.replace(/[^a-z0-9]/gi, ''))
          );
        });

        if (matchFound) {
          isMatchfound = true;
          profileURL = extractedUrl || '';
          if (telephones) cardPhoneNumbers.push(...telephones);
        }
      }
      return { profileURL, isMatchfound, cardPhoneNumbers };
    } catch (error) {
      console.error(`Error extracting profile URL by address`, error);
      return { profileURL: '', isMatchfound: false, cardPhoneNumbers: [] };
    }
  }

  /**
   * Busca dentro del HTML todos los <script type="application/ld+json">,
   * parsea el JSON y extrae el objeto Person (nombres, teléfonos, direcciones y URL).
   */
  extractDataFromLdJson(html) {
    const $ = cheerio.load(html);
    let result = null;

    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const raw = $(el).html()?.trim();
        if (!raw) return;

        const json = JSON.parse(raw);
        const jsonObjects = Array.isArray(json) ? json : [json];
        const person = jsonObjects.find(entry => entry['@type'] === 'Person');

        if (person) {
          result = {
            name: person.name,
            telephones: person.telephone || [],
            addresses: (person.address || []).map(addr => ({
              street: addr.streetAddress,
              city: addr.addressLocality,
              state: addr.addressRegion,
              postalCode: addr.postalCode,
              full: `${addr.streetAddress}, ${addr.addressLocality}, ${addr.addressRegion} ${addr.postalCode}`
            })),
            profileURL: person.url || person['@id'] || null
          };
        }
      } catch (err) {
        console.warn("⚠️ Error parsing JSON from <script type='ld+json'>:", err.message);
      }
    });

    return result;
  }

  /**
   * Procesa la URL de perfil del usuario encontrado, 
   * extrae teléfonos, parientes, asociados y correcciones de datos.
   * Se encarga de:
   *  - Extraer teléfonos directos y etiquetarlos,
   *  - Evitar duplicados,
   *  - Extraer parientes/asociados y sus nombres/URLs,
   *  - Extraer emails.
   */
  async processUserMatched(
    profileURL,
    allPhoneNumbers,
    allRelatives,
    allAssociates,
    allRelativeNames,
    allAssociateNames,
    allEmails
  ) {
    try {
      const {
        phoneNumbers,
        relatives,
        associates,
        relativeNames,
        associateNames,
        emailAddresses
      } = await this.extractDetailsByUrl(profileURL);

      // 1) Etiquetar y normalizar números
      const labeledObjects = await this.labelPhoneNumbers(phoneNumbers);
      // labeledObjects = [{ number: "(818) 216-1919", type: "W" }, ...]

      labeledObjects.forEach(({ number }) => {
        if (!allPhoneNumbers.includes(number)) {
          allPhoneNumbers.push(number);
        }
      });

      // 2) Parientes (solo agregar si no existe)
      relatives.forEach(relative => {
        if (!allRelatives.includes(relative)) allRelatives.push(relative);
      });
      associates.forEach(associate => {
        if (!allAssociates.includes(associate)) allAssociates.push(associate);
      });

      relativeNames.forEach(rn => {
        if (!allRelativeNames.includes(rn)) allRelativeNames.push(rn);
      });
      associateNames.forEach(an => {
        if (!allAssociateNames.includes(an)) allAssociateNames.push(an);
      });

      // 3) Emails (formatear y unik)
      emailAddresses.forEach(email => {
        if (!allEmails.includes(email)) allEmails.push(email);
      });

      return {
        allPhoneNumbers,
        allRelatives,
        allAssociates,
        allRelativeNames,
        allAssociateNames,
        allEmails
      };
    } catch (error) {
      console.error(`Error processing user details:`, error);
      return {
        allPhoneNumbers,
        allRelatives,
        allAssociates,
        allRelativeNames,
        allAssociateNames,
        allEmails
      };
    }
  }

  /**
   * Dada una URL de perfil, extrae detalles:
   *  - Teléfonos (array de strings),
   *  - URLs de parientes,
   *  - URLs de asociados,
   *  - Nombres de parientes y asociados,
   *  - Emails.
   */
  async extractDetailsByUrl(url) {
    try {
      let phoneNumbers = [],
        relatives = [],
        associates = [],
        relativeNames = [],
        associateNames = [],
        emailAddresses = [];

      const formattedURL = formatUrl(url);
      const html = await this.getHtmlContent(formattedURL);

      // Para cada sección ("Phone Numbers", "Possible Relatives", etc.) usamos extractDetailsByRowLabel
      relatives = await this.extractDetailsByRowLabel(html, "Possible Relatives", "a", "href");
      associates = await this.extractDetailsByRowLabel(html, "Possible Associates", "a", "href");
      phoneNumbers = await this.extractDetailsByRowLabel(html, "Phone Numbers", ".phone");
      relativeNames = await this.extractDetailsByRowLabel(html, "Possible Relatives", ".relative");
      associateNames = await this.extractDetailsByRowLabel(html, "Possible Associates", ".associate");
      emailAddresses = await this.extractDetailsByRowLabel(html, "Email Addresses", "a", "href");

      // Formatear URLs de email (por ejemplo: "mailto:usuario@ejemplo.com")
      const formattedEmails = emailAddresses.map(formatEmail);

      return {
        phoneNumbers,
        relatives,
        associates,
        relativeNames,
        associateNames,
        emailAddresses: formattedEmails
      };
    } catch (error) {
      console.error("Error extracting details by details url", url, error);
      return {
        phoneNumbers: [],
        relatives: [],
        associates: [],
        relativeNames: [],
        associateNames: [],
        emailAddresses: []
      };
    }
  }

  /**
   * Dado el HTML y un label de sección (rowLabel),
   * busca esa sección y devuelve un array:
   *   - Si 'attribute' está definido, devuelve $(selector).attr(attribute).
   *   - Si no, devuelve $(selector).text().trim().
   */
  async extractDetailsByRowLabel(html, rowLabel, selector, attribute = null) {
    const $ = cheerio.load(html);
    const rows = $('.row');
    let items = [];

    rows.each((index, row) => {
      const sectionLabel = $(row).find('h2.section-label');
      if (sectionLabel.length > 0 && sectionLabel.text().trim() === rowLabel) {
        if (attribute) {
          items = $(row)
            .find(selector)
            .map((i, el) => $(el).attr(attribute))
            .get();
        } else {
          items = $(row)
            .find(selector)
            .map((i, el) => $(el).text().trim())
            .get();
        }
      }
    });
    return items;
  }

  /**
   * Recorre un array de URLs de parientes (max limit),
   * extrae teléfonos de cada uno y arma un JSON con clave dinámica:
   *   relative0Name, relative0Contact1, relative0Contact2, ...
   */
  async crawlRelativesPhoneNumbers(relatives, relativeNames, associateNames = []) {
    let relativeUpdates = {};
    if (relatives.length) {
      const relativesSliced = relatives.slice(0, maximumRelativesToCrawl);

      await mapLimit(
        relativesSliced,
        async (relativeUrl, index) => {
          console.log(`Crawling Relative ${index}`);
          const relativeName = relativeNames[index] || '';
          const associateName = associateNames[index] || '';

          relativeUpdates[`relative${index}Name`] = relativeName;
          relativeUpdates[`associate${index}Name`] = associateName;
          relativeUpdates[`relative${index}URL`] = relativeUrl;

          const { phoneNumbers } = await this.extractDetailsByUrl(relativeUrl);
          if (phoneNumbers.length) {
            // generateUpdatesObject arma algo como { relative0Contact1: "123", relative0Contact2: "456", ... }
            relativeUpdates = {
              ...relativeUpdates,
              ...generateUpdatesObject(phoneNumbers, `relative${index}Contact`)
            };
          }
          await sleep(20);
        },
        maximumParallelLoops
      );
      return relativeUpdates;
    }
    return {};
  }

  /**
   * Verifica si en el HTML existe un botón de "siguiente página" habilitado.
   * Devuelve true si hay siguiente página, false si no.
   */
  async checkIfNextPageExists(html) {
    const $ = cheerio.load(html);
    const paginationUl = $('ul.pagination');
    if (!paginationUl.length) {
      return false;
    }
    const lastLiElement = $('ul.pagination li').eq(-2);
    const isDisabled = lastLiElement.hasClass('disabled');
    if (!lastLiElement || isDisabled) return false;
    return true;
  }

  /**
   * Devuelve cuántas requests se han hecho hasta el momento.
   */
  async getRequestCount() {
    return this.requestCount;
  }

  /**
   * Resetea el contador de requests a 0.
   */
  async resetRequestCount() {
    this.requestCount = 0;
  }

  /**
   * Busca un LLC por nombre usando BizFile, extrae el ID y el nombre completo del agente.
   * @param {string} name  Nombre del LLC
   * @returns {object} { firstName, lastName, fullName, id }
   */
  async getNameByLLC(name) {
    try {
      const postData = {
        SEARCH_VALUE: name,
        SEARCH_TYPE_ID: "1"
      };
      let firstName = '', lastName = '';
      const response = await this.axiosBizFileInstance.post('/api/Records/businesssearch', postData);
      const agentData = Object.values(response.data.rows)[0];
      const id = agentData?.ID;
      const ownerName = agentData?.AGENT || '';

      if (ownerName) {
        const nameArray = ownerName.split(" ");
        firstName = this.formatNamePart(nameArray[0]);
        lastName = this.formatNamePart(nameArray[nameArray.length - 1]);
      }
      return { firstName, lastName, fullName: ownerName, id };
    } catch (error) {
      console.error("Error getting owner name by LLC", error);
      return { firstName: '', lastName: '', fullName: '', id: null };
    }
  }

  /**
   * Formatea una parte de nombre (primera letra mayúscula, resto minúsculas).
   */
  formatNamePart(namePart) {
    return namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();
  }

  /**
   * Extrae nombre y apellido de un string dado pidiendo a OpenAI (GPT-3.5).
   * Responde con un objeto { firstName, lastName }.
   */
  async askChatGPT(inputString) {
    const prompt = `From the following string, extract the first name and last name, response should only include the name no titles, no especial characters\n"${inputString}"`;

    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a naming knowledgeable assistant, skilled in finding first and last name from given string' },
        { role: 'user', content: prompt }
      ],
      temperature: 0
    });

    const extractedLines = response.choices[0]?.message?.content?.split('\n') || [];
    let firstName = '', lastName = '';
    // Asume que el formato de respuesta es algo como:
    // FirstName: Damian
    // LastName: Sagranichne
    extractedLines.forEach(line => {
      const parts = line.split(':');
      if (parts.length === 2) {
        const key = parts[0].trim().toLowerCase();
        const value = parts[1].trim();
        if (key === 'firstname' || key === 'first name') {
          firstName = value;
        } else if (key === 'lastname' || key === 'last name') {
          lastName = value;
        }
      }
    });
    return { firstName, lastName };
  }

  /**
   * Dado un ID de LLC, usa BizFile para obtener dirección y ciudad/estado principal y mailing.
   * @param {number} id 
   * @returns {object} { agentMailingAddress, agentPropertyAddress }
   */
  async getLLCAgentAddressByID(id) {
    try {
      const response = await this.axiosBizFileInstance.get(`/api/FilingDetail/business/${id}/false`);
      const list = response.data.DRAWER_DETAIL_LIST;

      // 'Mailing Address' / 'Principal Address' vienen en un bloque de texto con saltos de línea
      const mailingAddress = this.getValueByLabel(list, 'Mailing Address');
      const propertyAddress = this.getValueByLabel(list, 'Principal Address');

      const mailingLines = (mailingAddress || '').split('\n');
      const propertyLines = (propertyAddress || '').split('\n');

      const agentMailingAddress = {
        formattedMailingaddress: mailingLines[0]?.trim().replace(/#\d+/g, '')?.toLowerCase(),
        formattedMailingCity: mailingLines[1]?.split(',')[0]?.trim().toLowerCase(),
        formattedMailingState: mailingLines[1]?.split(',')[1]?.trim().replace(/[^a-zA-Z]/g, '')?.toLowerCase()
      };

      const agentPropertyAddress = {
        formattedMailingaddress: propertyLines[0]?.trim().replace(/#\d+/g, '')?.toLowerCase(),
        formattedMailingCity: propertyLines[1]?.split(',')[0]?.trim().toLowerCase(),
        formattedMailingState: propertyLines[1]?.split(',')[1]?.trim().replace(/[^a-zA-Z]/g, '')?.toLowerCase()
      };

      return { agentMailingAddress, agentPropertyAddress };
    } catch (error) {
      console.error("Error getting llc agent address by id", error);
      return { agentMailingAddress: {}, agentPropertyAddress: {} };
    }
  }

  /**
   * Dado un array de objetos con { LABEL, VALUE }, devuelve el VALUE cuyo LABEL coincida.
   */
  getValueByLabel(data, label) {
    const foundItem = data.find(item => item.LABEL === label);
    return foundItem ? foundItem.VALUE : null;
  }
}

module.exports = Crawler;