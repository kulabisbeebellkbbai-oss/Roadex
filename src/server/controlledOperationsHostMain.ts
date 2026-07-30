import {
  createGithubSshNetworkAdapter,
  createNpmRegistryNetworkAdapter,
} from './controlledOperationsNetworkAdapters.js';
import { startControlledOperationsHost } from './controlledOperationsHost.js';

const server = startControlledOperationsHost(process.env, {
  npmRegistryAdapter: createNpmRegistryNetworkAdapter(),
  githubSshAdapter: createGithubSshNetworkAdapter(),
});

const stop = (): void => {
  server.close(() => process.exit(0));
};

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
