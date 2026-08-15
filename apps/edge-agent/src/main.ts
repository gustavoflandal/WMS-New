// RNF-PER-001: WMS Edge Agent - Local hardware bridge
// [LACUNA: Full Edge Agent implementation scheduled for Session 2]
import express from 'express';

const app = express();
const port = process.env.EDGE_AGENT_PORT || 3002;

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'edge-agent' });
});

// [LACUNA: Hardware interfaces (printers, scales, LPR, etc.) to be implemented]
// Placeholder endpoints:
app.post('/print', (_req, res) => {
  res.status(501).json({ error: 'Print endpoint not yet implemented' });
});

app.post('/scale/weigh', (_req, res) => {
  res.status(501).json({ error: 'Scale endpoint not yet implemented' });
});

app.listen(port, () => {
  console.log(`✓ Edge Agent listening on port ${port}`);
});
