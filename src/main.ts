import { loadConfig } from './config.js';
import { createGateway } from './server.js';

try {
  const config = loadConfig();
  const server = createGateway(config);
  server.listen(config.port, config.host, () => {
    process.stdout.write(JSON.stringify({ event: 'gateway_started', port: config.port }) + '\n');
  });
  server.on('error', () => { process.stderr.write('Gateway listener failed\n'); process.exitCode = 1; });
  const stop = () => {
    server.close();
    const timer = setTimeout(() => server.closeAllConnections(), 5000);
    timer.unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch {
  // Configuration values may include credentials; log only the failure category.
  process.stderr.write('Gateway startup failed: check required configuration\n');
  process.exitCode = 1;
}
