
import Homey from 'homey/lib/Homey';
import fs from 'node:fs/promises';

type LogLevel = 'info'|'error'
const LogFilePath = '/userdata/logs.txt'

export interface HomeyLogger {
  log: (...args: any[]) => void
}

const MAX_LOG_FILE_SIZE = 1024*1024 // 1MB

let logger:Logger|undefined

export function getLogger(homeyLog:HomeyLogger, enableFileStorage:boolean, logLevel:LogLevel):Logger {
  if(!logger) {
    logger = new Logger(homeyLog, enableFileStorage, logLevel)
  }
  return logger
}

interface LogMessage {
  [key:string] : string|number|object|undefined|null
}


let fileSizeCheckTimeout:NodeJS.Timeout|null = null

// debounce checks for file sizes b/c it's an expensive operation
async function scheduleCheckFileSize() {
  if(!fileSizeCheckTimeout) {
    fileSizeCheckTimeout = setTimeout(async () => {
      try {
        await enforceFileSize()
      } catch(err) {
        console.error(err)
      }
      fileSizeCheckTimeout = null
    }, 100)
  }
}

async function enforceFileSize() {
  const stat = await fs.stat(LogFilePath)
  if(stat.size >= MAX_LOG_FILE_SIZE) {
    let file = await fs.open(LogFilePath)
    let fileContent:string = await file.readFile('utf8')
    const ratio = MAX_LOG_FILE_SIZE/stat.size * 0.8  // delete 20% more than theoretically needed
    const charRatioToKeep = Math.min(ratio, 1)
    const numCharsToRemoveRatio = fileContent.length - Math.ceil(fileContent.length * charRatioToKeep)
    fileContent = fileContent.slice(numCharsToRemoveRatio)

    console.info(`Log file size exceeded. Expected ${MAX_LOG_FILE_SIZE}b but got ${stat.size}b. Trimming to ${fileContent.length} chars`)
    await file.writeFile(fileContent, 'utf8')
  }
}

export class Logger {
  homeyLogger: HomeyLogger|undefined
  logLevel
  enableFileStorage: boolean
  constructor(homeyLogger:HomeyLogger, enableFileStorage:boolean, logLevel:LogLevel) {
    this.homeyLogger = homeyLogger
    this.enableFileStorage = enableFileStorage
    this.logLevel = logLevel
  }

  async log(level:LogLevel , message:LogMessage|string|Error|any) {
    try {
      // if(level === 'error') {
      //   console.error(message)
      // } else {
      //   console.info(message)
      // }

      if(typeof message === 'string') {
        message = {
          msg: message
        }
      } else if(message instanceof Error) {
        message = {
          msg: message.message,
          stack: message.stack
        }
      }
      if(this.homeyLogger)  {
        this.homeyLogger.log(JSON.stringify(message))
      }
      if(this.logLevel === 'error' && level === 'info') {
        return
      }
      const timestamp = (new Date()).toISOString()
      const messageStr = JSON.stringify(message)
      const str = `${timestamp} ${level} - ${messageStr}`
      if(this.enableFileStorage) {
        const file = await fs.open(LogFilePath, 'a+')
        await file.appendFile(str + '\n', 'utf8')
        await file.close()
        await scheduleCheckFileSize()
      }
    } catch(err) {
      console.error(err)
    }
  }

  async info(message:LogMessage|string|Error|any) {
    return await this.log('info', message)
  }
  async error(message:LogMessage|string|Error|any) {
    return await this.log('error', message)
  }

}

export async function getLogsFromFile() {
  return await fs.readFile(LogFilePath, 'utf8')
}

export async function emptyLogFile() {
  return await fs.writeFile(LogFilePath, '', 'utf8')
}

enforceFileSize().catch(err => {
  console.error(err)
  // create the file if it could not be read
  emptyLogFile().then(() => enforceFileSize())
})