import os from "node:os";
import path from "node:path";

/** Platform home — everything Maya persists lives under here. */
export const mayaHome = (): string => process.env.MAYA_HOME || path.join(os.homedir(), ".maya");

export const configPath = (): string => path.join(mayaHome(), "config.json");
export const dbPath = (): string => path.join(mayaHome(), "maya.db");
export const modelsDir = (): string => path.join(mayaHome(), "models");
export const logsDir = (): string => path.join(mayaHome(), "logs");
