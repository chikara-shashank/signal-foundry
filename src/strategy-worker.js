import { parentPort, workerData } from 'node:worker_threads';
import { assess } from './strategies.js';
parentPort.on('message', ({ id, features, now }) => {
  try { parentPort.postMessage({ id, ...assess(workerData.strategy, features, now) }); }
  catch { parentPort.postMessage({ id, error: 'strategy_error' }); }
});
