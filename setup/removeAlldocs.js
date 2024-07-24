require("dotenv").config({ path: __dirname + "/../.variables.env" });
const fs = require("fs");

const mongoose = require("mongoose");
const documents = require("../models/ProcessCsv"); 

mongoose.connect(process.env.DATABASE);
mongoose.Promise = global.Promise; // Tell Mongoose to use ES6 promises


async function removeAllDocs(){
    try {

        // Remove all documents
        await documents.deleteMany();
        
    } catch (error) {
        console.error("Error: ", error);
    }
}
removeAllDocs();