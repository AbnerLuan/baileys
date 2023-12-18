import express from 'express';

const app = express();
app.use(express.json()); // para suportar JSON-encoded bodies

const PORT = 3000; // Escolha uma porta para o servidor

app.post('/webhook', (req, res) => {
    console.log('Requisição recebida:', req.body);
    // Aqui você pode adicionar sua lógica para manipular a requisição
    res.status(200).send('Requisição recebida');
});


app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
