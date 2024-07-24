const mongoose = require("mongoose");
mongoose.Promise = global.Promise;

const processCSVSchema = new mongoose.Schema({
    fileContent: {
        type: Object,
        required: true,
    },
    status: {
        type: String,
        enum: ['processing', 'completed', 'failed', 'canceled'],
        default: 'processing',
    },
    totalRows: {
        type: Number,
        default: 0
    },
    rowsProcessed: {
        type: Number,
        default: 0
    },
    createdAt: {
        type: Date,
        default: Date.now,
    },
    completedAt: {
        type: Date,
    },
    processingTime: {
        type: Number
    },
    requestCount: {
        type: Number,
        default: 0
    }
});

module.exports = mongoose.model("ProcessCSV", processCSVSchema);







