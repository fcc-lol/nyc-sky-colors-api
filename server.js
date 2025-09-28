import express from 'express';

const app = express();
const port = 3113;

app.get('/', (req, res) => {
  res.send('NYC Sky Colors');
});

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});

