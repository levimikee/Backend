const axios = require('axios')
const cheerio = require('cheerio')
const { AUTH, OPENAI_KEY } = process.env
const { generateUpdatesObject, formatString, formatUrl, formatEmail } = require('../utils')
const { maximumParallelLoops, maximumRelativesToCrawl } = require('../config')
const { mapLimit, sleep } = require('modern-async')
const OpenAI = require('openai');
const openai = new OpenAI({ apiKey: OPENAI_KEY });


class Crawler {
    constructor() {
        this.axiosInstance = axios.create({
            baseURL: "https://api.zyte.com/v1/extract",
            auth: {
                username: AUTH
            }
        })
        this.axiosBizFileInstance = axios.create({
            baseURL: 'https://bizfileonline.sos.ca.gov',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'undefined',
                'User-Agent': 'PostmanRuntime/7.28.4',
                'Host': ''
            }
        })
        this.requestCount = 0
    }

    /**
     * Take the url and returns HTTP response body
     * @param {string} url 
     * @returns {httpResponseBody} 
     */
    async getHtmlContent(url) {
        let result = "";
        try {
            const response = await this.axiosInstance.post("", {
                url,
                httpResponseBody: true,
            });

            if (response.status === 200) {
                const httpResponseBody = Buffer.from(
                    response.data.httpResponseBody,
                    "base64"
                );

                result = httpResponseBody.toString("utf8") || "";
            }
            this.requestCount++
        } catch (error) {
            console.error({ url, error: error.message });
        } finally {
            return result;
        }
    }

    /**
     * Searches through the site and Gives back phone number of matching user, relatives, Relatives phone, associates
     * @param {string} mailingAddress 
     * @param {string} city 
     * @param {string} state 
     * @param {object} ownerDetails 
     * @returns {object}
     */
    async searchByAddress(address, city, state, ownerDetails) {
        try {
            let currentPage = 1;
            let allPhoneNumbers = [];
            let isUserMatched = false
            let allRelatives = [], allAssociates = [], allRelativeNames = [], allAssociateNames = [], allEmails = []

            while (true) {
                const formattedAddress = formatString(address)
                const formattedCity = formatString(city)
                const formattedState = formatString(state)
                const url = `https://www.cyberbackgroundchecks.com/address/${formattedAddress}/${formattedCity}/${formattedState}/${currentPage}`

                console.log(`Crawling page no ${currentPage}, URL: ${url}`)

                const html = await this.getHtmlContent(url);

                // First try to see if the user exists, if it does return its detail profile url
                const { profileURL, isMatchfound, cardPhoneNumbers } = await this.getDetailsProfileURL(ownerDetails, html, address);
                isUserMatched = isUserMatched ? true : isMatchfound
                if(cardPhoneNumbers) allPhoneNumbers.push(...cardPhoneNumbers)

                if (isUserMatched) {
                    const processedData = await this.processUserMatched(profileURL, allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails);
                    ({ allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails } = processedData);
                }

                const nextPageAvailable = await this.checkIfNextPageExists(html)
                if (!nextPageAvailable) break;
                currentPage++;
            }

            return { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails };
        } catch (error) {
            console.error(`Error searching user by address: ${address}: `, error);
            return { allPhoneNumbers: [], isUserMatched: false, allRelatives: [], allAssociates: [], allRelativeNames: [], allAssociateNames: [], allEmails: [] }
        }
    }

    /**
     * 
     * @param {string} name 
     * @param {string} propertyAddress 
     * @param {string} address 
     * @param {string} city 
     * @param {string} state 
     * @returns {object}
     */
    async searchByName(name, propertyAddress, address, city, state) {
        try {
            let currentPage = 1
            let allPhoneNumbers = [];
            let isUserMatched = false
            let allRelatives = [], allAssociates = [], allRelativeNames = [], allAssociateNames = [], allEmails = []

            while (true) {
                const formattedName = formatString(name)
                const formattedCity = formatString(city)
                const formattedState = formatString(state)
                const url = `https://www.cyberbackgroundchecks.com/people/${formattedName}/${formattedState}/${formattedCity}/${currentPage}`

                console.log(`Crawling page no ${currentPage}, URL: ${url}`)

                const html = await this.getHtmlContent(url)

                // First try to see if the user exists, if it does return its detail profile url
                const { profileURL, isMatchfound, cardPhoneNumbers } = await this.getDetailsProfileURLByAddress(address, propertyAddress, html);
                isUserMatched = isUserMatched ? true : isMatchfound
                if(cardPhoneNumbers) allPhoneNumbers.push(...cardPhoneNumbers)

                if (isUserMatched) {
                    const processedData = await this.processUserMatched(profileURL, allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails);
                    ({ allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails } = processedData);
                }

                const nextPageAvailable = await this.checkIfNextPageExists(html)
                if (!nextPageAvailable) break;
                currentPage++;
            }

            return { allPhoneNumbers, isUserMatched, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails }
        } catch (error) {
            console.error("Error searching user by name,", error)
            return { allPhoneNumbers: [], isUserMatched: false, allRelatives: [], allAssociates: [], allRelativeNames: [], allAssociateNames: [], allEmails: [] }
        }
    }

    /**
     * Takes Both addresses and returns profile URL of matched address.
     * @param {string} mailingAddress 
     * @param {string propertyAddress 
     * @param {httpResponseBody} htmlContent 
     * @returns {object}
     */
    async getDetailsProfileURLByAddress(mailingAddress, propertyAddress, htmlContent) {
        let profileURL = ''
        let isMatchfound = false
        const cardPhoneNumbers = []

        try {
            const lowercaseTargetMailingaddress = mailingAddress.toLowerCase();
            const lowercaseTargetPropertyaddress = propertyAddress.toLowerCase()

            const $ = cheerio.load(htmlContent)

            // Select all elements with class 'card'
            const cardList = $('.card');

            // Iterate over each card
            cardList.each((index, card) => {
                // Select the '.address' element within the card
                const address = $(card).find('.address');
                const phoneNumbers = $(card).find('.phone')

                phoneNumbers.each((index, element) => {
                    const phoneNumber = $(element).text().trim();
                    if(phoneNumber) cardPhoneNumbers.push(phoneNumber);
                });


                // Check if the '.address' element exists
                if (address.length > 0) {

                    const cardAddress = address.text().trim().toLowerCase();

                    // Check if card address matches the target mailing address
                    if (cardAddress.includes(lowercaseTargetMailingaddress) || cardAddress.includes(lowercaseTargetPropertyaddress)) {
                        isMatchfound = true

                        profileURL = $(card).find('[title*="View full"]').attr('href');
                    }
                }
            });
        } catch (error) {
            console.error(`Error extracting profile URL by address`, error)
        } finally {
            return { profileURL, isMatchfound, cardPhoneNumbers }
        }
    }

    /**
     * Main function responsible to extract all details from the profile and give us back proper data
     * @param {string} profileURL 
     * @param {Array} allPhoneNumbers 
     * @param {Array} allRelatives 
     * @param {Array} allAssociates 
     * @param {Array} allRelativeNames 
     * @param {Array} allAssociateNames 
     * @param {Array} allEmails 
     * @returns {Object}
     */
    async processUserMatched(profileURL, allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails) {
        try {
            // Fetch details with the url
            const { phoneNumbers, relatives, associates, relativeNames, associateNames, emailAddresses } = await this.extractDetailsByUrl(profileURL);
            if (phoneNumbers.length) phoneNumbers.forEach(phoneNumber => {
                if (!allPhoneNumbers.includes(phoneNumber)) allPhoneNumbers.push(phoneNumber);
            });
            if (relatives.length) relatives.forEach(relative => {
                if (!allRelatives.includes(relative)) allRelatives.push(relative);
            });
            if (associates.length) associates.forEach(associate => {
                if (!allAssociates.includes(associate)) allAssociates.push(associate);
            });
            if (relativeNames.length) relativeNames.forEach(relative => {
                if (!allRelativeNames.includes(relative)) allRelativeNames.push(relative);
            });
            if (associateNames.length) associateNames.forEach(associate => {
                if (!allAssociateNames.includes(associate)) allAssociateNames.push(associate);
            });
            if (emailAddresses.length) emailAddresses.forEach(email => {
                if (!allEmails.includes(email)) allEmails.push(email);
            });

            return { allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails };
        } catch (error) {
            console.error(`Error processing user details: `, error);
            return { allPhoneNumbers, allRelatives, allAssociates, allRelativeNames, allAssociateNames, allEmails };
        }
    }

    /**
     * Takes owner name and returns back matching profile URL
     * @param {object} ownerDetails 
     * @param {httpResponseBody} htmlContent 
     * @returns {object}
     */
    async getDetailsProfileURL(ownerDetails, htmlContent, address) {
        try {
            let profileURL = '';
            let isMatchfound = false;
            let cardPhoneNumbers = []
            const $ = cheerio.load(htmlContent);

            const cardList = $('.card');

            function pushPhone(phoneNumbers){
                phoneNumbers.each((index, element) => {
                    const phoneNumber = $(element).text().trim();
                    if (phoneNumber) cardPhoneNumbers.push(phoneNumber);
                });
            }

            for (let index = 0; index < cardList.length; index++) {
                const card = cardList.eq(index);
                const nameGiven = card.find('.name-given');

                const phoneNumbers = $(card).find('.phone')

                if (nameGiven.length > 0) {
                    const cardFullName = nameGiven.text().trim();
                    const ownerOneFullNAme = `${ownerDetails.ownerOneFirstName} ${ownerDetails.ownerOneLastName}`;
                    const ownerTwoFullNAme = `${ownerDetails.ownerTwoFirstName} ${ownerDetails.ownerTwoLastName}`;
                    const cardAddress = card.find('.address-current').text().trim();

                    if (
                        (ownerOneFullNAme.length && cardFullName === ownerOneFullNAme) ||
                        (ownerTwoFullNAme.length && cardFullName === ownerTwoFullNAme)
                    ) {
                        isMatchfound = true;
                        profileURL = card.find('[title*="View full"]').attr('href');
                        pushPhone(phoneNumbers)
                        return { profileURL: profileURL, isMatchfound: isMatchfound, cardPhoneNumbers };
                    }
                    else if (
                        (ownerDetails.ownerOneFirstName?.length && ownerDetails.ownerOneLastName?.length &&
                            cardFullName.includes(ownerDetails.ownerOneFirstName) && cardFullName.includes(ownerDetails.ownerOneLastName)) ||
                        (ownerDetails?.ownerTwoFirstName?.length && ownerDetails?.ownerTwoLastName?.length &&
                            cardFullName.includes(ownerDetails.ownerTwoFirstName) && cardFullName.includes(ownerDetails.ownerTwoLastName))
                    ) {
                        isMatchfound = true;
                        profileURL = card.find('[title*="View full"]').attr('href');
                        pushPhone(phoneNumbers)
                        return { profileURL: profileURL, isMatchfound: isMatchfound, cardPhoneNumbers };
                    }
                    else if (
                        (
                            !ownerDetails.ownerOneFirstName?.length && ownerDetails.ownerOneLastName?.length &&
                            cardFullName.includes(ownerDetails.ownerOneLastName) && cardAddress.includes(address)
                        )
                        ||
                        (
                            !ownerDetails.ownerTwoFirstName?.length && ownerDetails.ownerTwoLastName?.length &&
                            cardFullName.includes(ownerDetails.ownerTwoLastName) && cardAddress.includes(address)
                        )
                    ) {
                        isMatchfound = true;
                        profileURL = card.find('[title*="View full"]').attr('href');
                        pushPhone(phoneNumbers)
                        return { profileURL: profileURL, isMatchfound: isMatchfound, cardPhoneNumbers };
                    }
                }
            }
        } catch (error) {
            console.error(`Error extracting profile URL`, error);
        }

        // Return a default value if no match is found
        return { profileURL: '', isMatchfound: false, cardPhoneNumbers: [] };
    }


    /**
     * Extracts phone numbers, relatives, associates from the profile url
     * @param {string} url 
     * @returns 
     */
    async extractDetailsByUrl(url) {
        try {
            let phoneNumbers = [], relatives = [], associates = [], relativeNames = [], associateNames = [], emailAddresses = []
            const formattedURL = formatUrl(url)

            // Now lets browse the details profile url
            const html = await this.getHtmlContent(formattedURL);

            // Lets extract Phone numbers, Relatives and Associates
            relatives = await this.extractDetailsByRowLabel(html, "Possible Relatives", "a", "href")
            associates = await this.extractDetailsByRowLabel(html, "Possible Associates", "a", "href")
            phoneNumbers = await this.extractDetailsByRowLabel(html, "Phone Numbers", ".phone")
            relativeNames = await this.extractDetailsByRowLabel(html, "Possible Relatives", ".relative")
            associateNames = await this.extractDetailsByRowLabel(html, "Possible Associates", ".associate")
            emailAddresses = await this.extractDetailsByRowLabel(html, "Email Addresses", "a", "href")
            const formattedEmails = emailAddresses.map(formatEmail);
            return { phoneNumbers, relatives, associates, relativeNames, associateNames, emailAddresses: formattedEmails }
        } catch (error) {
            console.error("Error extracting details by details url", url, error)
            return { phoneNumbers: [], relatives: [], associates: [], relativeNames: [], associateNames: [], emailAddresses: [] }
        }
    }

    /**
     * Extract content by section label 
     * @param {httpResponseBody} html 
     * @param {string} rowLabel 
     * @param {string} selector 
     * @param {string} attribute 
     * @returns {Array}
     */
    async extractDetailsByRowLabel(html, rowLabel, selector, attribute = null) {
        const $ = cheerio.load(html)
        const rows = $('.row');
        let hrefs = []

        rows.each(async (index, row) => {
            const sectionLabel = $(row).find('h2.section-label');
            if (sectionLabel.length > 0 && sectionLabel.text().trim() === rowLabel) {

                if (attribute) {
                    hrefs = $(row).find(selector).map((index, element) => $(element).attr(attribute)).get();
                } else {
                    hrefs = $(row).find(selector).map((index, element) => $(element).text().trim()).get();
                }

            }
        });
        return hrefs;
    }

    /**
     * Takes relatives, associates details and gives back json data. For example: relative1contact1: '', relative2name:'' and etc
     * @param {Array} relatives 
     * @param {Array} relativeNames 
     * @param {Array} associateNames 
     * @returns {object}
     */
    async crawlRelativesPhoneNumbers(relatives, relativeNames, associateNames = []) {
        let relativeUpdates = {}
        if (relatives.length) {
            const relativesSliced = relatives.slice(0, maximumRelativesToCrawl)
            await mapLimit(relativesSliced, async (relative, index) => {
                console.log(`Crawling Relative ${index}`)

                const relativeName = relativeNames[index];
                relativeUpdates[`relative${index}Name`] = relativeName;

                const associateName = associateNames[index];
                relativeUpdates[`associate${index}Name`] = associateName;

                relativeUpdates[`relative${index}URL`] = relative

                const { phoneNumbers } = await this.extractDetailsByUrl(relative)
                if (phoneNumbers.length) {
                    relativeUpdates = {
                        ...relativeUpdates,
                        ...generateUpdatesObject(phoneNumbers, `relative${index}Contact`),
                    }
                }
                sleep(20)
            }, maximumParallelLoops)
            return relativeUpdates
        }
    }

    /**
     * Checks if the next page button is disabled or not
     * @param {httpResponseBody} html 
     * @returns {boolean}
     */
    async checkIfNextPageExists(html) {

        const $ = cheerio.load(html)

        const paginationUl = $('ul.pagination');
        if (!paginationUl.length) {
            return false;
        }

        const lastLiElement = $('ul.pagination li').eq(-2)

        const isDisabled = lastLiElement.hasClass('disabled');
        if (!lastLiElement || isDisabled) return false;
        return true
    }

    /**
     * Returns total request count
     */
    async getRequestCount() {
        return this.requestCount
    }

    /**
     * Resets request count to 0
     */
    async resetRequestCount() {
        this.requestCount = 0
    }

    /**
     * Gets LLC name and tries to find onwer name
     * @param {string} name 
     */
    async getNameByLLC(name) {
        try {
            const postData = {
                "SEARCH_VALUE": name,
                "SEARCH_TYPE_ID": "1"
            };
            let firstName = '', lastName = ''
            const response = await this.axiosBizFileInstance.post('/api/Records/businesssearch', postData)
            const Agentdata = (Object.values(response.data.rows)[0])
            const id = Agentdata?.ID
            const ownerName = Agentdata?.AGENT

            if (ownerName) {
                const nameArray = ownerName?.split(" ")
                firstName = this.formatNamePart(nameArray[0])
                lastName = this.formatNamePart(nameArray[nameArray.length - 1])
            }
            return { firstName, lastName, fullName: ownerName, id }
        } catch (error) {
            console.error("Error getting owner name by LLC", error)
        }
    }

    /**
     * Returns formatted name
     * @param {string} namePart 
     * @returns 
     */
    formatNamePart(namePart) {
        return namePart.charAt(0).toUpperCase() + namePart.slice(1).toLowerCase();
    }


    async askChatGPT(inputString) {
        const prompt = `From the following string, extract the first name and last name, response should only include the name no titles, no especial characters\n"${inputString}"`;

        const response = await openai.chat.completions.create({
            model: 'gpt-3.5-turbo', 
            messages: [
                { "role": "system", "content": "You are a naming knowledgable assitance, skilled in finding first and last name from given string" },
                { "role": "user", content: prompt }
            ],
        });
        const extractedNames = response.choices[0]?.message?.content?.split('\n')
        const firstName = extractedNames[0]?.split(':')[1]?.trim()
        const lastName = extractedNames[1]?.split(':')[1]?.trim()
        return { firstName, lastName };
    }


    /**
     * Call details API for bizfile to get mailing address, property address, city and states.
     * @param {number} id 
     * @returns {object}
     */
    async getLLCAgentAddressByID(id) {
        try {
            const response = await this.axiosBizFileInstance.get(`/api/FilingDetail/business/${id}/false`)
            const list = response.data.DRAWER_DETAIL_LIST
            // console.log(list)
            const mailingAddress = this.getValueByLabel(list, 'Mailing Address')
            const propertyAddress = this.getValueByLabel(list, 'Principal Address')

            const mailingAddressSplitarray = mailingAddress?.split('\n')
            const propertyAddressSplitarray = propertyAddress?.split('\n')

            const agentMailingAddress = {
                formattedMailingaddress: mailingAddressSplitarray[0].trim().replace(/#\d+/g, '')?.toLowerCase(),
                formattedMailingCity: mailingAddressSplitarray[1]?.split(',')[0]?.trim().toLowerCase(),
                formattedMailingState: mailingAddressSplitarray[1]?.split(',')[1]?.trim().replace(/[^a-zA-Z]/g, '')?.toLowerCase()
            }

            const agentPropertyAddress = {
                formattedMailingaddress: propertyAddressSplitarray[0].trim().replace(/#\d+/g, '')?.toLowerCase(),
                formattedMailingCity: mailingAddressSplitarray[1]?.split(',')[0]?.trim().toLowerCase(),
                formattedMailingState: mailingAddressSplitarray[1]?.split(',')[1]?.trim().replace(/[^a-zA-Z]/g, '')?.toLowerCase()
            }

            return { agentMailingAddress, agentPropertyAddress }
        } catch (error) {
            console.error("Error getting llc agent address by id", error)
        }
    }

    /**
     * From the array of key values data, function returns value of label we are interested in.
     * @param {array} data 
     * @param {string} label 
     * @returns {string}
     */
    getValueByLabel(data, label) {
        const foundItem = data.find(item => item.LABEL === label);

        if (foundItem) {
            return foundItem.VALUE;
        } else {
            return null;
        }
    }
}

module.exports = Crawler
