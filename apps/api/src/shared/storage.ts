import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const storageRoot = join(process.cwd(), 'storage');
export const executionsRoot = join(storageRoot, 'executions');
export const dashboardsRoot = join(storageRoot, 'dashboards');

export function dashboardRoot(dashboardId: string) {
  return join(dashboardsRoot, dashboardId);
}
export const schedulesRoot = join(storageRoot, 'schedules');
export const robotsRoot = join(storageRoot, 'robots');
export const sitesRoot = join(storageRoot, 'sites');
export const siteChatAttachmentsRoot = join(storageRoot, 'site-chat-attachments');

export function executionRoot(executionId: string) {
  return join(executionsRoot, executionId);
}

export function inputDir(executionId: string) {
  return join(executionRoot(executionId), 'input');
}

export function outputDir(executionId: string) {
  return join(executionRoot(executionId), 'output');
}

export function metadataDir(executionId: string) {
  return join(executionRoot(executionId), 'metadata');
}

export function scheduleRoot(scheduleId: string) {
  return join(schedulesRoot, scheduleId);
}

export function scheduleInputDir(scheduleId: string) {
  return join(scheduleRoot(scheduleId), 'input');
}

export function robotRoot(robotId: string) {
  return join(robotsRoot, robotId);
}

export function robotExamplesDir(robotId: string) {
  return join(robotRoot(robotId), 'examples');
}

export async function ensureExecutionDirs(executionId: string) {
  await mkdir(inputDir(executionId), { recursive: true });
  await mkdir(outputDir(executionId), { recursive: true });
  await mkdir(metadataDir(executionId), { recursive: true });
}

export async function ensureStorageRoot() {
  await mkdir(executionsRoot, { recursive: true });
  await mkdir(schedulesRoot, { recursive: true });
  await mkdir(robotsRoot, { recursive: true });
}

export async function ensureScheduleDirs(scheduleId: string) {
  await mkdir(scheduleInputDir(scheduleId), { recursive: true });
}

export function robotScriptsDir(robotId: string) {
  return join(robotRoot(robotId), 'scripts');
}

export function robotPipDir(robotId: string) {
  return join(robotRoot(robotId), 'pip');
}

export async function ensureRobotExampleDirs(robotId: string) {
  await mkdir(robotExamplesDir(robotId), { recursive: true });
}

export async function ensureRobotScriptsDirs(robotId: string) {
  await mkdir(robotScriptsDir(robotId), { recursive: true });
}

export async function ensureRobotPipDir(robotId: string) {
  await mkdir(robotPipDir(robotId), { recursive: true });
}

export function siteRoot(siteId: string) {
  return join(sitesRoot, siteId);
}

export async function ensureSiteDir(siteId: string) {
  await mkdir(siteRoot(siteId), { recursive: true });
}
