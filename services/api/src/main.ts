import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { createApp } from './bootstrap';
import { config } from './config';

async function main() {
  const app = await createApp();
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  new Logger('Rased').log(`API listening on :${config.port}`);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
