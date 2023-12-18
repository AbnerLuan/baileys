const { makeWASocket, MessageType } = require('@whiskeysockets/baileys');

async function startWhatsApp() {
    const sock = makeWASocket({
        printQRInTerminal: true
    });

    sock.ev.on('connection.update', (update) => {
        const { connection } = update;
        if (connection === 'open') {
            console.log('Conexão estabelecida!');
            // Envie uma mensagem após a conexão ser estabelecida
            sendMessage();
        }
    });

    async function sendMessage() {
        const message = { text: 'Olá, esta é uma mensagem teste!' };
        const recipientId = '5511975070239@s.whatsapp.net'; // Substitua pelo número do destinatário real

        await sock.sendMessage(recipientId, message, MessageType.text);
    }
}

startWhatsApp();
