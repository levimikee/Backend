// slackNotifier.js
const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();
const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
if (!slackWebhookUrl) {
  throw new Error("SLACK_WEBHOOK_URL is not defined in the environment variables.");
}

/**
 * Envía un mensaje predefinido a un webhook de Slack
 */
function notifySlack(response) {
  const message = {
    text: response || "Mensaje predeterminado",
  };

  axios.post(slackWebhookUrl, message)
    .then(() => {
      console.log("Mensaje enviado a Slack con éxito.");
    })
    .catch((error) => {
      console.error("Error al enviar el mensaje a Slack:", error);
    });
}

module.exports = { notifySlack };