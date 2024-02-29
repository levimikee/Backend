const csv = require('csv-parser');
const Crawler = require('../actions/crawler')
const cheerio = require('cheerio')
const { generateUpdatesObject } = require('../utils')
const { columnMappings } = require('../config/index')
const { mapLimit, sleep } = require('modern-async')
const { maximumParallelLoops } = require('../config')
const ProcessCSV = require('../models/ProcessCsv')
const Papa = require('papaparse');
//Create instance of crawler
const webCrawler = new Crawler()

const fileApi = {
    uploadFile: async (req, res) => {
        // Check if a file is included in the request
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded.' });
        }

        // Access the file buffer
        const fileBuffer = req.file.buffer;

        // Convert buffer to string (assuming it's a text-based CSV)
        const fileContent = fileBuffer.toString('utf-8');

        // Parse CSV
        const rows = [];
        fileContent
            .trim() // Remove leading/trailing whitespaces
            .split('\n') // Split into rows
            .forEach((row, index) => {

                // Split each row into columns
                const columns = row.split(',');

                // Extract specific columns (3, 4, 5, 9, 10)
                const extractedData = {
                    index: index,
                    address: columns[0],
                    city: columns[2],
                    state: columns[3],
                    zip: columns[4],
                    ownerOneFirstName: columns[8],
                    ownerOneLastName: columns[9],
                    ownerTwoFirstName: columns[10],
                    ownerTwoLastName: columns[11],
                    mailingAddress: columns[13],
                    mailingCity: columns[15],
                    mailingState: columns[16]
                };

                rows.push(extractedData);
            });


        let documentId = null
        const result = await saveToDB(fileContent, res)
        if (result) {
            documentId = result?._id
            res.status(200).json({
                success: true,
                result,
                message: "Successfully Created the document in Model ",
            });
        }

        const updatedContent = await crawlAndSave(rows, fileContent, documentId)
        if (updatedContent && documentId) {
            await updateDB(documentId, updatedContent)
            await webCrawler.resetRequestCount()
        }
    },
    checkStatus: async (req, res) => {
        try {
            const document = await ProcessCSV.findById(req.params.id);

            if (!document) {
                return res.status(404).json({ error: 'Document not found' });
            }

            // Document found, check status
            res.json({ status: document.status, totalRows: document.totalRows, rowsProcessed: document.rowsProcessed, completedAt: document.completedAt, fileContent: document.fileContent });
        } catch (error) {
            console.error('Error checking status:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    },
    getAllCsvList: async (req, res) => {
        try {
            const documents = await ProcessCSV.find().sort({ createdAt: -1 })
            res.json({ data: documents })
        } catch (error) {
            console.error("Error getting all CSV list", error)
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
};

/**
 * Main function loops through rows, collect JSON updates to be made data and passes whole JSON updates data to save function
 * @param {Array} rows 
 * @param {Array} fileContent 
 * @returns {Array}
 */
const crawlAndSave = async (rows, fileContent, documentId) => {
    try {
        let updatedContent = fileContent
        const totalRows = rows.length
        if (totalRows > 0) {

            let sharedData = {}
            let rowsProcessed = 0
            const startTime = Date.now();
            await mapLimit(rows, async (row, index) => {
                if (index !== 0) {
                    const updateContext = await crawlData(row)
                    sharedData[index] = updateContext
                    rowsProcessed++
                    const rowUpdateInfo = {
                        totalRows: totalRows - 1,
                        rowsProcessed: rowsProcessed,
                        processingTime: Date.now() - startTime,
                        requestCount: await webCrawler.getRequestCount()
                    }
                    updateDB(documentId, null, rowUpdateInfo)
                }

            }, maximumParallelLoops)

            // Lets save the context
            for (const key in sharedData) {
                if (sharedData.hasOwnProperty(key)) {
                    const currentContext = sharedData[key];
                    console.log(currentContext)
                    updatedContent = await saveData(updatedContent, currentContext, key);
                }
            }

            return updatedContent
        }
    } catch (error) {
        console.error("Error during crawling and saving:", error)
    }
}

/**
 * Takes a single row, Work on decision tree and get JSON data to be updated and returns it
 * @param {object} rowData 
 * @returns {object}
 */
const crawlData = async (rowData) => {
    try {

        // Strcture data we need for proceesing
        let ownerOneName = `${rowData.ownerOneFirstName} ${rowData.ownerOneLastName}`
        const ownerTwoName = `${rowData.ownerTwoFirstName} ${rowData.ownerTwoLastName}`
        let { ownerOneFirstName, ownerOneLastName, ownerTwoFirstName, ownerTwoLastName, mailingAddress, address, mailingCity, mailingState, city, state } = rowData

        const temporaryownerOneLastName = ownerOneLastName
        if (/llc/i.test(temporaryownerOneLastName)) {
            const { firstName, lastName, fullName, id } = await webCrawler.getNameByLLC(ownerOneLastName);
            ownerOneName = `${firstName} ${lastName}`;
            ownerOneFirstName = firstName;
            ownerOneLastName = lastName;

            const ignoreLlcResultsString = (process.env.IGNORE_LLC_RESULTS_STRINGS).split(',')
            const matchesIgnoreValue = ignoreLlcResultsString.some(value => new RegExp(value, 'i').test(fullName));
            if (matchesIgnoreValue) {
                console.error("Exiting row, LLC agent name includes other company")
                return {}
            }

            if (id) {
                const { agentMailingAddress, agentPropertyAddress } = await webCrawler.getLLCAgentAddressByID(id)
                mailingAddress = agentMailingAddress.formattedMailingaddress
                mailingCity = agentMailingAddress.formattedMailingCity
                mailingState = agentMailingAddress.formattedMailingState
                address = agentPropertyAddress.formattedMailingaddress
                city = agentPropertyAddress.formattedMailingCity
                state = agentPropertyAddress.formattedMailingState
            }
        }


        const fundDetectionStrings = (process.env.FUND_DETECTION_STRINGS || 'fund,funds,family').split(',');
        if (fundDetectionStrings.some(str => new RegExp(str, 'i').test(temporaryownerOneLastName))) {
            const { firstName, lastName } = await webCrawler.askChatGPT(temporaryownerOneLastName);
            ownerOneName = `${firstName} ${lastName}`;
            ownerOneFirstName = firstName;
            ownerOneLastName = lastName;
        }
        const ownerDetails = { ownerOneFirstName, ownerOneLastName, ownerTwoFirstName, ownerTwoLastName }

        // First lets check my mailing address to see if we find both owners
        console.info(`\n \n ---- Searching for ROW: ${rowData.index} Mailing address:  ${mailingAddress} for user 1: ${ownerOneName}, user 2: ${ownerTwoName}`)

        const { finalUpdates, caseOneMatchFound } = await crawlByAddress(mailingAddress, mailingCity, mailingState, ownerDetails)
        if (caseOneMatchFound) {
            return finalUpdates
        }


        // First condition did not satisfy, Lets check for second, Search by owner one name
        console.info(`\n \n -------- Searching by owner one name:  ${ownerOneName} for mailing address : ${mailingAddress}`)

        const { finalUpdates: finalUpdatesByName, caseTwoMatchFound: caseNameMatchFound } = await crawlByName(ownerOneName, address, mailingAddress, mailingCity, mailingState)
        if (caseNameMatchFound) {
            return finalUpdatesByName
        }


        // Second condition did not satisfy, Lets check for third, Search by column property address   
        console.info(`\n \n ------------ Searching for Property address:  ${address} for user 1: ${ownerOneName}, user 2: ${ownerTwoName}`)

        const { finalUpdates: propertyaddress, caseOneMatchFound: propertyaddressMatchFound } = await crawlByAddress(address, city, state, ownerDetails)
        if (propertyaddressMatchFound) {
            return propertyaddress
        }


        // Check if we have owner two data available if yes search by owner two name
        if (ownerTwoName.trim().length) {
            console.info(`\n \n ------------ Searching by owner two name:  ${ownerTwoName} for mailing address: ${mailingAddress}, property address: ${address}`)

            const { finalUpdates: finalUpdatesByName, caseTwoMatchFound: caseNameMatchFound } = await crawlByName(ownerTwoName, address, mailingAddress, mailingCity, mailingState)
            if (caseNameMatchFound) {
                const OwnerInsideRelativesAndPartnersListURL = isOwnerInsideRelativesAndPartners(finalUpdatesByName, ownerDetails)
                if (OwnerInsideRelativesAndPartnersListURL) {

                    const { phoneNumbers, relatives, relativeNames } = await this.extractDetailsByUrl(profileURL)
                    const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(relatives, relativeNames)

                    let phoneUpdates = null
                    if (phoneNumbers.length) {
                        phoneUpdates = generateUpdatesObject(phoneNumbers, 'ownerMobile')
                    }

                    finalUpdates = { ...relativeUpdates, ...phoneUpdates }
                    return finalUpdates
                }
                return finalUpdatesByName
            }
        }

        return {}
    } catch (error) {
        console.error("Error crawling data", error)
    }

}

/**
 * Call search function by address, get phone numbers, relatives and etc, create JSON structure of data and returns JSON data and a boolean to say if the match was found
 * @param {string} mailingAddress 
 * @param {string} city 
 * @param {string} state 
 * @param {object} ownerDetails 
 * @returns {object}
 */
const crawlByAddress = async (mailingAddress, city, state, ownerDetails) => {
    try {
        const { allPhoneNumbers: caseONeNumbers, isUserMatched: caseOneMatchFound, allRelatives: caseOneRelatives, allRelativeNames: relativeNames, allAssociateNames: associateNames, allEmails
        } = await webCrawler.searchByAddress(mailingAddress, city, state, ownerDetails)

        console.log("Is User Matched? ", caseOneMatchFound)
        let finalUpdates = null
        if (caseOneMatchFound) {
            const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(caseOneRelatives, relativeNames, associateNames)

            let phoneUpdates = null
            if (caseONeNumbers.length) {
                phoneUpdates = generateUpdatesObject(caseONeNumbers, 'ownerMobile')
            }

            let emailUpdates = null
            if (allEmails?.length) {
                emailUpdates = generateUpdatesObject(allEmails, 'email')
            }

            const finalUpdates = { ...relativeUpdates, ...phoneUpdates, ...emailUpdates }
            return { finalUpdates, caseOneMatchFound }
        }
        return { finalUpdates, caseOneMatchFound }
    } catch (error) {
        console.error("Error crawling by address", error)
    }
}

/**
 * Call search function by name, get phone numbers, relatives and etc, create JSON structure of data and returns JSON data and a boolean to say if the match was found
 * @param {string} ownerOneName 
 * @param {string} propertyAddress 
 * @param {string} address 
 * @param {string} city 
 * @param {*string state 
 * @returns 
 */
const crawlByName = async (ownerOneName, propertyAddress, address, city, state) => {
    try {
        const { allPhoneNumbers: caseTwoNumbers, isUserMatched: caseTwoMatchFound, allRelatives: caseTwoRelatives, allRelativeNames: relativeNames, allAssociateNames: associateNames, allEmails
        } = await webCrawler.searchByName(ownerOneName, propertyAddress, address, city, state)

        let finalUpdates = null

        if (caseTwoMatchFound) {
            const relativeUpdates = await webCrawler.crawlRelativesPhoneNumbers(caseTwoRelatives, relativeNames, associateNames)

            let phoneUpdates = null
            if (caseTwoNumbers.length) {
                phoneUpdates = generateUpdatesObject(caseTwoNumbers, 'ownerMobile')
            }

            let emailUpdates = null
            if (allEmails?.length) {
                emailUpdates = generateUpdatesObject(allEmails, 'email')
            }

            finalUpdates = { ...relativeUpdates, ...phoneUpdates, ...emailUpdates }
            return { finalUpdates, caseTwoMatchFound }
        }
        return { finalUpdates, caseTwoMatchFound }
    } catch (error) {
        console.error("Error crawling by name", error)
    }
}

/**
 * Takes all csv data, JSON data to be updated, and index of row and updates data accordingly.
 * @param {Array} fileContent 
 * @param {object} updates 
 * @param {number} rowIndex 
 * @returns 
 */
const saveData = (fileContent, updates, rowIndex) => {
    try {
        // Parse the CSV data
        const parsedData = Papa.parse(fileContent, { header: false });

        // Check if the rowIndex is within the valid range
        if (rowIndex < 0 || rowIndex >= parsedData.data.length) {
            console.error('Invalid rowIndex. Row does not exist.');
            return null;
        }

        // Get the specified row
        const row = parsedData.data[rowIndex];

        // Update the row based on the provided updates object
        for (const columnName in updates) {
            const columnIndex = getColumnIndex(columnName);
            if (columnIndex !== -1) {
                row[columnIndex] = updates[columnName];
            }
        }

        // Convert the updated data back to CSV
        const updatedContent = Papa.unparse(parsedData.data, { header: false });

        console.log('Row updated successfully!');
        return updatedContent;
    } catch (error) {
        console.error('Error updating CSV row:', error.message);
        return null;
    }
};

/**
 * Pass the column name and it will give back us the index of that column using configuration file
 * @param {string} columnName 
 * @returns {number}
 */
const getColumnIndex = (columnName) => {
    // Logic to map column names to their corresponding indices'
    try {
        return columnMappings[columnName] || -1;
    } catch (error) {
        console.error("Error getting column index", error)
    }
}

/**
 * Returns the profile URL of the onwer one who is also relative/associate of owner two
 * @param {Array} data 
 * @param {object} ownerDetails 
 * @returns {string}
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
            const cardFullName = (data[key]).trim()
            if (cardFullName.includes(ownerDetails.ownerOneFirstName) && cardFullName.includes(ownerDetails.ownerOneLastName)) {
                // Check if the corresponding URL key exists
                const urlKey = key.replace("Name", "URL");
                if (data[urlKey]) {
                    return data[urlKey];
                }
            }
        }

        return null; // Return null if no match is found
    } catch (error) {
        console.error("Error checking if owner one is also relative/associate of owner two", error)
    }

};


const saveToDB = async (fileContent, res) => {
    try {
        const result = await new ProcessCSV({
            fileContent
        }).save();

        return result
    } catch (err) {
        if (err.name == "ValidationError") {
            return res.status(400).json({
                success: false,
                result: null,
                message: "Required fields are not supplied",
            });
        } else {
            return res.status(500).json({
                success: false,
                result: null,
                message: "Oops there is an Error",
            });
        }
    }
}

const updateDB = async (id, updatedContent, info) => {
    try {
        const documentExists = await ProcessCSV.exists({ _id: id });

        if (!documentExists) {
            console.log('Document not found');
            return false;
        }

        if (updatedContent) {
            const result = await ProcessCSV.findByIdAndUpdate(
                id,
                { status: 'completed', completedAt: new Date(), fileContent: updatedContent },
                {
                    new: true,
                    runValidators: true,
                }
            ).exec();
        } else if (info) {
            const result = await ProcessCSV.findByIdAndUpdate(
                id,
                { totalRows: info?.totalRows, rowsProcessed: info?.rowsProcessed, processingTime: info?.processingTime, requestCount: info?.requestCount },
                {
                    new: true,
                    runValidators: true,
                }
            ).exec();
        }



        return true;
    } catch (error) {
        console.error('Error updating Database', error);
        return false;
    }
};


module.exports = {
    fileApi,
};
