// Helper function to create dynamic updates object// remove this helper function once its working from utils
function generateUpdatesObject(phoneNumbers, propertyName) {
    const updates = {};

    phoneNumbers.forEach((phoneNumber, index) => {
        // Dynamically create property names like 'ownerMobile1', 'ownerMobile2', etc.
        const dynamicPropertyName = `${propertyName}${index + 1}`;

        // Add the property to the updates object
        updates[dynamicPropertyName] = phoneNumber;
    });

    return updates;
}

function formatString(string) {
    return string.trim().replace(/\s+/g, '-').replace(/#\d+/g, '');
}

function formatUrl(url) {
    return `https://www.cyberbackgroundchecks.com${url}`
}

function formatEmail(inputString) {
    const emailPart = inputString.split('/email/')[1];
    if (emailPart) {
        const regex = /_\.+(?!.*_.)/;
        const formattedEmail = emailPart.replace(regex, '@');
        return formattedEmail;
    }
    return null;
}


module.exports = { generateUpdatesObject, formatString, formatUrl, formatEmail }