import { getLogsFromFile, emptyLogFile } from './utils/logging.js'
export async function getLogs() {
    return await getLogsFromFile();
}
export async function deleteLogs() {
    return await emptyLogFile();
}