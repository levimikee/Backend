require("dotenv").config({ path: __dirname + "/../.variables.env" });
const fs = require("fs");

const mongoose = require("mongoose");
const User = require("../models/Admin"); 
mongoose.connect(process.env.DATABASE);
mongoose.Promise = global.Promise; // Tell Mongoose to use ES6 promises


async function createRootUser(){
    try {


        // Find all admins and update their isRootUser property to false
        await User.updateMany({ isRootUser: false });

        
       // create a root user if it doesn't exist
        let rootUser = await User.findOne({ email: 'leviroot' });
        // delete rootUser
        await User.deleteOne({ email: 'leviroot' });
        rootUser = undefined;
        if (!rootUser) {
            const newUser = new User();
            const user = new User({
                email: 'leviroot',
                name: 'levi',
                surname: 'root',
                password: newUser.generateHash("451zweqpi0oo91ss"),
                isRootUser: true,
            });
            await user.save();
        }
    } catch (error) {
        console.error("Error updating root users:", error);
    }
}
createRootUser()