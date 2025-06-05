// controllers/fileController.js

const Crawler = require('../actions/crawler');
const { generateUpdatesObject } = require('../utils');
 const { columnMappings, maximumParallelLoops } = require('../config');const { mapLimit, sleep } = require('modern-async');
const ProcessCSV = require('../models/ProcessCsv');
const Papa = require('papaparse');
const { notifySlack } = require('../actions/slack');

// Instancia del crawler
const webCrawler = new Crawler();

const fileApi = {
  /**
   * Recibe el CSV desde un formulario “multipart/form-data”,
   * lo parsea, guarda el contenido crudo en BD, y luego lanza
   * el proceso de crawling para extraer datos adicionales.
   */
  uploadFile: async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded.' });
    }

    // Obtener buffer y convertir a string
    const fileBuffer = req.file.buffer;
    const fileContent = fileBuffer.toString('utf-8');

    // Guardar el CSV crudo en la base de datos
    let documentId = null;
    try {
      const result = await new ProcessCSV({
        fileContent
      }).save();
      documentId = result._id;

      // Responder inmediatamente con OK y el ID
      res.status(200).json({
        success: true,
        result,
        message: 'Document created in DB successfully.'
      });
    } catch (err) {
      if (err.name === 'ValidationError') {
        return res.status(400).json({
          success: false,
          result: null,
          message: 'Required fields are not supplied'
        });
      } else {
        return res.status(500).json({
          success: false,
          result: null,
          message: 'Oops there is an Error saving to DB'
        });
      }
    }

    // Una vez guardado en BD, comenzamos el proceso de crawling en background
    try {
      const updatedContent = await crawlAndSave(fileContent, documentId);
      if (updatedContent && documentId) {
        await updateDB(documentId, updatedContent);
        await webCrawler.resetRequestCount();
      }
    } catch (error) {
      console.error("Error during crawling and saving:", error);
    }
  },

  /**
   * Cancela el proceso de scraping si aún no se completó.
   */
  cancelProcessing: async (req, res) => {
    try {
      const document = await ProcessCSV.findById(req.params.id);
      if (!document) {
        return res.status(404).json({ error: 'Document not found' });
      }
      if (document.status === 'completed') {
        return res.status(400).json({ error: 'Document has already been processed' });
      }
      await ProcessCSV.findByIdAndUpdate(req.params.id, { status: 'cancelled' });
      res.json({ success: true });
    } catch (error) {
      console.error("Error cancelling process", error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  /**
   * Consulta el estado actual del procesamiento (para que el front muestre progreso).
   */
  checkStatus: async (req, res) => {
    try {
      const document = await ProcessCSV.findById(req.params.id);
      if (!document) {
        return res.status(404).json({ error: 'Document not found' });
      }
      res.json({
        status: document.status,
        totalRows: document.totalRows,
        rowsProcessed: document.rowsProcessed,
        completedAt: document.completedAt,
        fileContent: document.fileContent
      });
    } catch (error) {
      console.error('Error checking status:', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  },

  /**
   * Devuelve la lista de todos los documentos CSV procesados.
   */
  getAllCsvList: async (req, res) => {
    try {
      const documents = await ProcessCSV.find().sort({ createdAt: -1 });
      res.json({ data: documents });
    } catch (error) {
      console.error("Error getting all CSV list", error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

/**
 * Verifica si el usuario ha cancelado el procesamiento de un documento.
 * @param {string} documentId
 * @returns {boolean} true si el status es 'cancelled'
 */
const isProcessingCancelled = async (documentId) => {
  try {
    const document = await ProcessCSV.findById(documentId);
    return document.status === 'cancelled';
  } catch (error) {
    console.error('Error checking if processing is cancelled:', error);
    return true; // si falla la consulta, asumimos que sí está cancelado
  }
};

/**
 * Recorre cada fila del CSV (menos la cabecera), lanza crawlByAddress/crawlByName y
 * arma un objeto con los updates necesarios para esa fila. Luego invoca saveData para
 * sobreescribir la fila en el CSV completo.
 * @param {string} fileContent  Contenido completo del CSV (string)
 * @param {string} documentId
 * @returns {string|null} El contenido CSV actualizado o null si falla
 */
const crawlAndSave = async (fileContent, documentId) => {
  try {
    let updatedContent = fileContent;
    const parsedData = Papa.parse(fileContent, { header: false });
    const totalRows = parsedData.data.length;

    if (totalRows <= 1) {
      // Si sólo hay cabecera o está vacío, no hay filas por procesar
      return updatedContent;
    }

    let sharedData = {};
    let rowsProcessed = 0;
    const startTime = Date.now();

    // Procesamos cada fila con concurrencia limitada
    await mapLimit(
      parsedData.data,
      async (row, index) => {
        // index = 0 corresponde a la primera fila (normalmente pedidos de cabecera).
        // Nosotros sólo procesamos index !== 0
        if (index === 0) return;

        // ¿Fue cancelado el procesamiento?
        if (await isProcessingCancelled(documentId)) {
          console.log('Document processing cancelled');
          return;
        }

        // Ejecutar crawler sobre esta fila
        const rowData = {
          index,
          address: row[columnMappings.address],
          city: row[columnMappings.city],
          state: row[columnMappings.state],
          zip: row[columnMappings.zip],
          ownerOneFirstName: row[columnMappings.ownerOneFirstName],
          ownerOneLastName: row[columnMappings.ownerOneLastName],
          ownerTwoFirstName: row[columnMappings.ownerTwoFirstName],
          ownerTwoLastName: row[columnMappings.ownerTwoLastName],
          mailingAddress: row[columnMappings.mailingAddress],
          mailingCity: row[columnMappings.mailingAddress] ? row[columnMappings.mailingCity] : '',
          mailingState: row[columnMappings.mailingAddress] ? row[columnMappings.mailingState] : '',
          city: row[columnMappings.city],
          state: row[columnMappings.state]
        };

        // crawlData devolverá un objeto con las claves a actualizar para esa fila
        const updateContext = await crawlData(rowData, documentId);
        sharedData[index] = updateContext;

        rowsProcessed++;
        const rowUpdateInfo = {
          totalRows: totalRows - 1,     // excluimos cabecera
          rowsProcessed,
          processingTime: Date.now() - startTime,
          requestCount: await webCrawler.getRequestCount()
        };
        await updateDB(documentId, null, rowUpdateInfo);
      },
      maximumParallelLoops
    );

    // Si cancelaron durante el procesamiento, no guardamos cambios
    if (await isProcessingCancelled(documentId)) {
      console.log('Document processing cancelled');
      return updatedContent;
    }

    // Ahora iteramos sobre sharedData para aplicar cada update a la fila correspondiente
    for (const key in sharedData) {
      if (sharedData.hasOwnProperty(key)) {
        const rowIndex = Number(key);
        const currentContext = sharedData[key];
        if (currentContext && Object.keys(currentContext).length > 0) {
          const newContent = saveData(updatedContent, currentContext, rowIndex);
          if (newContent) {
            updatedContent = newContent;
          }
        }
      }
    }

    return updatedContent;
  } catch (error) {
    console.error("Error during crawlAndSave:", error);
    return null;
  }
};

/**
 * Dado un objeto rowData con los datos de la fila (dirección, nombres, etc.),
 * ejecuta las tres fases de búsqueda:
 *   1) crawlByAddress con mailingAddress
 *   2) crawlByName si no halló en mailingAddress
 *   3) crawlByAddress con propertyAddress si no halló en las dos anteriores
 * Devuelve un objeto { finalUpdates, caseFound } donde finalUpdates
 * contiene las claves a escribir en CSV.
 */
const crawlData = async (rowData, documentId) => {
  try {
    let {
      ownerOneFirstName,
      ownerOneLastName,
      ownerTwoFirstName,
      ownerTwoLastName,
      mailingAddress,
      address,
      mailingCity,
      mailingState,
      city,
      state
    } = rowData;

    let ownerOneName = `${ownerOneFirstName} ${ownerOneLastName}`;
    const ownerTwoName = `${ownerTwoFirstName} ${ownerTwoLastName}`;

    // 1) Si el apellido contiene “LLC”, pregunto a BizFile por el nombre real del agente
    if (/llc/i.test(ownerOneLastName)) {
      if (await isProcessingCancelled(documentId)) {
        console.log('Document processing cancelled');
        return {};
      }
      const { firstName, lastName, fullName, id } = await webCrawler.getNameByLLC(ownerOneLastName);
      ownerOneName = `${firstName} ${lastName}`;
      ownerOneFirstName = firstName;
      ownerOneLastName = lastName;

      // Si el LLC coincide con lista de exclusión, omitimos esta fila
      const ignoreLlcResultsString = (process.env.IGNORE_LLC_RESULTS_STRINGS || '').split(',');
      const matchesIgnoreValue = ignoreLlcResultsString.some(value => new RegExp(value, 'i').test(fullName));
      if (matchesIgnoreValue) {
        console.error("Exiting row, LLC agent name includes other company");
        return {};
      }

      if (id) {
        if (await isProcessingCancelled(documentId)) {
          console.log('Document processing cancelled');
          return {};
        }
        const { agentMailingAddress, agentPropertyAddress } = await webCrawler.getLLCAgentAddressByID(id);
        mailingAddress = agentMailingAddress.formattedMailingaddress;
        mailingCity = agentMailingAddress.formattedMailingCity;
        mailingState = agentMailingAddress.formattedMailingState;
        address = agentPropertyAddress.formattedMailingaddress;
        city = agentPropertyAddress.formattedMailingCity;
        state = agentPropertyAddress.formattedMailingState;
      }
    }

    // 2) Si el apellido contiene palabras clave tipo “fund”, le pido a GPT el nombre real (ej. “John Smith Fund” → “John Smith”)
    const fundDetectionStrings = (process.env.FUND_DETECTION_STRINGS || 'fund,funds,family').split(',');
    if (fundDetectionStrings.some(str => new RegExp(str, 'i').test(ownerOneLastName))) {
      if (await isProcessingCancelled(documentId)) {
        console.log('Document processing cancelled');
        return {};
      }
      const { firstName, lastName } = await webCrawler.askChatGPT(ownerOneLastName);
      ownerOneName = `${firstName} ${lastName}`;
      ownerOneFirstName = firstName;
      ownerOneLastName = lastName;
    }

    const ownerDetails = {
      ownerOneFirstName,
      ownerOneLastName,
      ownerTwoFirstName,
      ownerTwoLastName
    };

    // 3) Fase 1: busco por mailingAddress
    console.info(`\n---- Searching for ROW: ${rowData.index} Mailing address: ${mailingAddress} for user1: ${ownerOneName}, user2: ${ownerTwoName}`);
    if (await isProcessingCancelled(documentId)) {
      console.log('Document processing cancelled');
      return {};
    }
    const { finalUpdates: finalUpdatesByAddr, caseOneMatchFound } = await crawlByAddress(
      mailingAddress,
      mailingCity,
      mailingState,
      ownerDetails
    );
    if (caseOneMatchFound) {
      return finalUpdatesByAddr;
    }

    // 4) Fase 2: busco por ownerOneName (nombre completo)
    console.info(`\n-------- Searching by owner one name: ${ownerOneName} for mailing address: ${mailingAddress}`);
    if (await isProcessingCancelled(documentId)) {
      console.log('Document processing cancelled');
      return {};
    }
    const { finalUpdates: finalUpdatesByName, caseTwoMatchFound } = await crawlByName(
      ownerOneName,
      address,
      mailingAddress,
      mailingCity,
      mailingState
    );
    if (caseTwoMatchFound) {
      return finalUpdatesByName;
    }

    // 5) Fase 3: busco por propertyAddress
    console.info(`\n------------ Searching for Property address: ${address} for user1: ${ownerOneName}, user2: ${ownerTwoName}`);
    if (await isProcessingCancelled(documentId)) {
      console.log('Document processing cancelled');
      return {};
    }
    const { finalUpdates: finalUpdatesByPropAddr, caseOneMatchFound: propAddrMatchFound } = await crawlByAddress(
      address,
      city,
      state,
      ownerDetails
    );
    if (propAddrMatchFound) {
      return finalUpdatesByPropAddr;
    }

    // 6) Si ownerTwoName no está vacío, pruebo buscarlo
    if (ownerTwoName.trim().length) {
      console.info(`\n------------ Searching by owner two name: ${ownerTwoName} for mailing address: ${mailingAddress}, property address: ${address}`);
      if (await isProcessingCancelled(documentId)) {
        console.log('Document processing cancelled');
        return {};
      }
      const { finalUpdates: finalUpdatesByName2, caseTwoMatchFound: caseNameMatchFound2 } = await crawlByName(
        ownerTwoName,
        address,
        mailingAddress,
        mailingCity,
        mailingState
      );
      if (caseNameMatchFound2) {
        // Si el ownerTwo aparece como pariente/asociado de ownerOne, extraigo sub-parientes
        const OwnerInsideRelativesAndPartnersListURL = isOwnerInsideRelativesAndPartners(finalUpdatesByName2, ownerDetails);
        if (OwnerInsideRelativesAndPartnersListURL) {
          if (await isProcessingCancelled(documentId)) {
            console.log('Document processing cancelled');
            return {};
          }
          const { phoneNumbers, relatives, relativeNames } = await webCrawler.extractDetailsByUrl(OwnerInsideRelativesAndPartnersListURL);
          if (await isProcessingCancelled(documentId)) {
            console.log('Document processing cancelled');
            return {};
          }
          const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(relatives, relativeNames);
          if (await isProcessingCancelled(documentId)) {
            console.log('Document processing cancelled');
            return {};
          }
          let phoneUpdates = null;
          if (phoneNumbers.length) {
            // Si hallamos teléfonos de la URL de pariente, usamos generateUpdatesObject
            phoneUpdates = generateUpdatesObject(phoneNumbers, 'ownerMobile');
          }
          const finalRelUpdates = { ...relativeUpdates, ...phoneUpdates };
          return finalRelUpdates;
        }
        return finalUpdatesByName2;
      }
    }

    // Si no se encontró nada
    return {};
  } catch (error) {
    console.error("Error crawling data", error);
    return {};
  }
};

/**
 * Lógica para buscar por dirección dentro de crawlData.
 * Similar a searchByAddress pero devuelve finalUpdates + flag.
 */
const crawlByAddress = async (mailingAddress, city, state, ownerDetails) => {
  try {
    const {
      allPhoneNumbers: caseOneNumbers,
      isUserMatched: caseOneMatchFound,
      allRelatives: caseOneRelatives,
      allRelativeNames: relativeNames,
      allAssociateNames: associateNames,
      allEmails
    } = await webCrawler.searchByAddress(mailingAddress, city, state, ownerDetails);

    let finalUpdates = null;
    if (caseOneMatchFound) {
      // 1) Extracción de parientes
      const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(caseOneRelatives, relativeNames, associateNames);

      // 2) En vez de generateUpdatesObject(caseOneNumbers, 'ownerMobile'),
      //    etiquetamos cada teléfono y generamos ownerMobileN + ownerMobileNType
      let phoneUpdates = {};
      if (caseOneNumbers.length) {
        const labeled = await webCrawler.labelPhoneNumbers(caseOneNumbers);
        labeled.forEach(({ number, type }, idx) => {
          const n = idx + 1;
          phoneUpdates[`ownerMobile${n}`]     = number;
          phoneUpdates[`ownerMobile${n}Type`] = type;
        });
      }

      // 3) Emails (igual que antes)
      let emailUpdates = {};
      if (allEmails?.length) {
        emailUpdates = generateUpdatesObject(allEmails, 'email');
      }

      // 4) Combinar todo
      finalUpdates = {
        ...relativeUpdates,
        ...phoneUpdates,
        ...emailUpdates
      };
      return { finalUpdates, caseOneMatchFound };
    }

    return { finalUpdates, caseOneMatchFound };
  } catch (error) {
    console.error("Error crawling by address", error);
    return { finalUpdates: null, caseOneMatchFound: false };
  }
};

/**
 * Lógica para buscar por nombre dentro de crawlData.
 * Similar a searchByName pero devuelve finalUpdates + flag.
 */
const crawlByName = async (ownerOneName, propertyAddress, address, city, state) => {
  try {
    const {
      allPhoneNumbers: caseTwoNumbers,
      isUserMatched: caseTwoMatchFound,
      allRelatives: caseTwoRelatives,
      allRelativeNames: relativeNames,
      allAssociateNames: associateNames,
      allEmails
    } = await webCrawler.searchByName(ownerOneName, propertyAddress, address, city, state);

    let finalUpdates = null;
    if (caseTwoMatchFound) {
      // 1) Extracción de parientes
      const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(caseTwoRelatives, relativeNames, associateNames);

      // 2) Teléfonos
      let phoneUpdates = {};
      if (caseTwoNumbers.length) {
        const labeled = await webCrawler.labelPhoneNumbers(caseTwoNumbers);
        labeled.forEach(({ number, type }, idx) => {
          const n = idx + 1;
          phoneUpdates[`ownerMobile${n}`]     = number;
          phoneUpdates[`ownerMobile${n}Type`] = type;
        });
      }

      // 3) Emails
      let emailUpdates = {};
      if (allEmails?.length) {
        emailUpdates = generateUpdatesObject(allEmails, 'email');
      }

      // 4) Combinar
      finalUpdates = {
        ...relativeUpdates,
        ...phoneUpdates,
        ...emailUpdates
      };
      return { finalUpdates, caseTwoMatchFound };
    }

    return { finalUpdates, caseTwoMatchFound };
  } catch (error) {
    console.error("Error crawling by name", error);
    return { finalUpdates: null, caseTwoMatchFound: false };
  }
};

/**
 * Actualiza una sola fila (índice rowIndex) dentro de fileContent (string CSV),
 * escribiendo los valores de 'updates' en las columnas que corresponden
 * según columnMappings. Luego regresa el CSV completo modificado.
 *
 * @param {string} fileContent  CSV completo como string
 * @param {object} updates      Objeto con claves = nombres de columna, valores = valor a escribir
 * @param {number} rowIndex     Índice de la fila a actualizar (0-based)
 * @returns {string|null}       Nuevo CSV completo o null si falla
 */
const saveData = (fileContent, updates, rowIndex) => {
  try {
    // Parsear todo el CSV (sin header)
    const parsed = Papa.parse(fileContent, { header: false });
    const data = parsed.data;

    // Si rowIndex no existe, no hacemos nada
    if (rowIndex < 0 || rowIndex >= data.length) {
      console.error('Invalid rowIndex. Row does not exist.');
      return null;
    }

    // Tomamos la fila a modificar
    const row = data[rowIndex];

    // Recorremos cada clave en updates y obtenemos su índice
    for (const columnName in updates) {
      const columnIndex = columnMappings[columnName];
      if (columnIndex !== undefined && columnIndex >= 0) {
        row[columnIndex] = updates[columnName];
      }
    }

    // Reconstruir el CSV completo
    const updatedContent = Papa.unparse(data, { header: false });
    return updatedContent;
  } catch (error) {
    console.error('Error updating CSV row:', error.message);
    return null;
  }
};

/**
 * Actualiza el documento en MongoDB:
 *  - Si llega 'updatedContent', marca status='completed', graba completedAt y actualiza fileContent.
 *  - Si llega 'info', actualiza solo totalRows, rowsProcessed, processingTime, requestCount.
 */
const updateDB = async (id, updatedContent, info) => {
  try {
    const exists = await ProcessCSV.exists({ _id: id });
    if (!exists) {
      console.log('Document not found');
      return false;
    }

    if (updatedContent) {
      await ProcessCSV.findByIdAndUpdate(
        id,
        {
          status: 'completed',
          completedAt: new Date(),
          fileContent: updatedContent
        },
        { new: true, runValidators: true }
      ).exec();
    } else if (info) {
      await ProcessCSV.findByIdAndUpdate(
        id,
        {
          totalRows: info.totalRows,
          rowsProcessed: info.rowsProcessed,
          processingTime: info.processingTime,
          requestCount: info.requestCount
        },
        { new: true, runValidators: true }
      ).exec();
    }

    return true;
  } catch (error) {
    console.error('Error updating Database', error);
    return false;
  }
};

/**
 * Dado un objeto finalUpdates y las llaves ownerOneFirstName, ownerOneLastName, etc.,
 * verifica si el ownerOne aparece dentro de los parientes de ownerTwo. Si es así,
 * retorna la URL de ese pariente.
 */
const isOwnerInsideRelativesAndPartners = (data, ownerDetails) => {
  try {
    const findKeysContainingName = (obj) => {
      const result = [];
      for (const key in obj) {
        if (key.includes("Name")) {
          result.push(key);
        }
      }
      return result;
    };

    const keysContainingName = findKeysContainingName(data);
    for (const key of keysContainingName) {
      const cardFullName = data[key]?.trim() || '';
      if (
        cardFullName.includes(ownerDetails.ownerOneFirstName) &&
        cardFullName.includes(ownerDetails.ownerOneLastName)
      ) {
        const urlKey = key.replace("Name", "URL");
        if (data[urlKey]) {
          return data[urlKey];
        }
      }
    }

    return null;
  } catch (error) {
    console.error("Error checking if owner one is also relative/associate of owner two", error);
    return null;
  }
};

module.exports = { fileApi };