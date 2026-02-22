import { JobManager } from './job-manager.js';
import { defaultJobRegistry } from './core/job-registry.js';
import { JobRunner } from './core/job-runner.js';

export const jobManager = new JobManager(1);

export const repoRoot = process.cwd();
export const jobRegistry = defaultJobRegistry(repoRoot);
jobRegistry.bootstrapFromDisk();
jobRegistry.markOrphansAsFailed('Bot restarted; marking in-flight job as failed');

export const jobRunner = new JobRunner(jobRegistry, 1);
