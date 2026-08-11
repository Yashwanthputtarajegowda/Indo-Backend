import 'dotenv/config';
import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, app: 'Indo-Backend' });
});

app.get('/', (_req, res) => {
  res.json({ app: 'Indo-Backend', status: 'running' });
});

app.listen(PORT, () => {
  console.log(`Indo backend running on port ${PORT}`);
});
