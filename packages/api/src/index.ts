import { buildServer } from './server.js';

const PORT = parseInt(process.env.PORT ?? '3010', 10);
const HOST = process.env.HOST ?? '0.0.0.0';

const server = buildServer();

server.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Faultline API listening at ${address}`);
});
