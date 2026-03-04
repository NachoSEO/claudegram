import { config } from '../config.js';
import { JobManager } from './job-manager.js';
import { defaultJobRegistry } from './core/job-registry.js';
import { JobRunner } from './core/job-runner.js';

export const jobManager = new JobManager(1);

export const repoRoot = process.cwd();
export const jobRegistry = defaultJobRegistry(repoRoot);
jobRegistry.bootstrapFromDisk();
jobRegistry.reconcileStartup('Bot restarted; reconciling in-flight jobs', config.JOB_RECONCILE_MODE);

export const jobRunner = new JobRunner(jobRegistry, 1);
