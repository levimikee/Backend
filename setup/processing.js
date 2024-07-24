require("dotenv").config({ path: __dirname + "/../.variables.env" });
const fs = require("fs");

const mongoose = require("mongoose");
const documents = require("../models/ProcessCsv"); 

mongoose.connect(process.env.DATABASE);
mongoose.Promise = global.Promise; // Tell Mongoose to use ES6 promises


async function processing(){
    try {

        // Find all processCsv that have processing status
        const processingDocuments = await documents.find({ status: 'processing' });
        // count how many documents are processing
        console.log ("Processing documents: ", processingDocuments.length);
        // update the status of the documents to completed
        //await documents.updateMany({ status: 'processing' }, { $set: { status: 'completed' } });
        
    } catch (error) {
        console.error("Error: ", error);
    }
}
processing();