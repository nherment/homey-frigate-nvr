import { Image } from "homey";
import axios from "axios";
import { FrigateNVRConfig, FrigateNVREventHandler, FrigateNVROccupancyHandler, MQTTFrigateEvent, MQTTOccupancy } from "./types";
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import { pipeline } from 'node:stream'
import { Readable, Writable } from "node:stream";
import { Logger } from "../../utils/logging";

export const fetchFrigateConfig = async(frigateURL:string) => {
  const response = await axios.get<FrigateNVRConfig>(`${frigateURL}/api/config`, {
    timeout: 10000
  })
  if(!response || response.status !== 200) {
    throw new Error(`Failed to reach FrigateNVR at <url>. Received error ${response.status} - ${response.statusText}`)
  } else {
    return response.data
  }
}

export const axiosStream = (url:string):(stream:Writable)=>Promise<void> => {
  return async (stream:Writable) => {
    try {
      const res = await axios({
        method: 'get',
        url: url,
        responseType: 'stream'
      })
      if(res.status !== 200) {
        const err = new Error(`Failed to fetch image ${url}. httpStatusCode=${res.status}. ${res.statusText}`)
        console.error({msg: err.message})
      }
      const readable:Readable = res.data
      pipeline(readable, stream, (err:any) => {
        if(err) {
          console.error({msg: `Failed to pipe image ${url}. Error: ${err.message}`})
        }
      })
    } catch(err:any) {
      console.error({msg: `Failed to fetch ${url}. Error: ${err.message}`})
    }
  }
}

export const getCameraLatestImage = async(args: {image:Image, frigateURL:string, cameraName:string}) => {
  const url = `${args.frigateURL}/api/${args.cameraName}/latest.jpg`
  args.image.setStream(axiosStream(url))
}

export const getCameraObjectSnapshotImage = async(args: {image:Image, frigateURL:string, cameraName:string, object:string}) => {
  const url = `${args.frigateURL}/api/${args.cameraName}/${args.object}/snapshot.jpg`
  args.image.setStream(axiosStream(url))
}

export const getCameraObjectThumbnailImage = async(args: {image:Image, frigateURL:string, cameraName:string, object:string}) => {
  const url = `${args.frigateURL}/api/${args.cameraName}/${args.object}/thumbnail.jpg`
  args.image.setStream(axiosStream(url))
}

export const getEventSnapshotImage = (args:{image:Image, frigateURL:string, eventId:string}) => {
  return getEventImage({...args, type: 'snapshot'})
}

export const getEventThumbnailImage = (args:{image:Image, frigateURL:string, eventId:string}) => {
  return getEventImage({...args, type: 'thumbnail'})
}

export const getEventImage = async(args:{image:Image, frigateURL:string, eventId:string, type:'thumbnail'|'snapshot'}) => {
  const url = `${args.frigateURL}/api/events/${args.eventId}/${args.type}.jpg`
  args.image.setStream(axiosStream(url))
}

interface OccupancyTopic {
  topic: string
  cameraName: string
  trackedObject: string
}

interface Device {
  cameraName: string
  trackedObjects: string[]
  occupancyTopics: OccupancyTopic[]
  eventHandler: FrigateNVREventHandler
  occupancyHandler: FrigateNVROccupancyHandler
}

interface MQTTConnection {
  client: MqttClient
  config: IClientOptions
  topicPrefix: string
  devices: Device[]
}

let currentConnection:MQTTConnection|null = null;

const handleFrigateEvent = async (connection:MQTTConnection, event:MQTTFrigateEvent, logger:Logger) => {
  for(let device of connection.devices) {
    if(event.after.camera === device.cameraName) {
      try {
        device.eventHandler(event).catch(err => {
          logger.error({msg: `Asynchronous error while executing event listener for camera ${device.cameraName}`, error: err.message, stack: err.stack})
        })
        return; // Expect a single device per camera
      } catch(err:any) {
        logger.error({msg: `Synchronous error while executing event listener for camera ${device.cameraName}`, error: err.message, stack: err.stack})
      }
    }
  }
}
const handleOccupancyChange = async (connection:MQTTConnection, occupancy:MQTTOccupancy, logger:Logger) => {
  for(let device of connection.devices) {
    if(occupancy.cameraName === device.cameraName) {
      try {
        device.occupancyHandler(occupancy).catch(err => {
          logger.error({msg: `Asynchronous error while executing event listener for camera ${device.cameraName}`, error: err.message, stack: err.stack})
        })
        return; // Expect a single device per camera
      } catch(err:any) {
        logger.error({msg: `Synchronous error while executing event listener for camera ${device.cameraName}`, error: err.message, stack: err.stack})
      }
    }
  }
}

function findOccupancyTopic(devices:Device[], topic:string):OccupancyTopic|null {
  // TODO: make the lookup faster and O(1)
  for(let device of devices) {
    for(let occupancyTopic of device.occupancyTopics) {
      if(occupancyTopic.topic === topic) {
        return occupancyTopic
      }
    }
  }
  return null
}

const connectToMQTTServer = async (mqttConfig:IClientOptions, mqttTopicPrefix:string, logger:Logger):Promise<MQTTConnection> => {
  mqttConfig.clientId = 'homey-frigate-nvr'
  if(!currentConnection) {

    logger.info(`Creating new connection to MQTT server ${mqttConfig.username}@${mqttConfig.host}:${mqttConfig.port}`)
    let client:MqttClient = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, mqttConfig)
    currentConnection = {
      client: client,
      config: mqttConfig,
      topicPrefix: mqttTopicPrefix,
      devices: []
    }

    currentConnection.client = client
    client.setMaxListeners(100) // avoid warnings when many cameras initialised and listen to the connect event
    client.on('error', (err) => {
      logger.error(err)
    })
    // client.on('reconnect', () => {
    //   logger.info({msg: 'Client attempting to reconnect', id: thisClientId, mqtt: {username: mqttConfig.username, host: mqttConfig.host, port: mqttConfig.port}})
    // })
    // client.on('close', () => {
    //   logger.info({msg: 'Client closed', id: thisClientId, mqtt: {username: mqttConfig.username, host: mqttConfig.host, port: mqttConfig.port}})
    // })
    // client.on('disconnect', () => {
    //   logger.info({msg: 'Client disconnected by broker', id: thisClientId, mqtt: {username: mqttConfig.username, host: mqttConfig.host, port: mqttConfig.port}})
    // })
    const eventsTopic = `${mqttTopicPrefix}/events`

    client.on('message', async (topic:string, message:Buffer) => {
      try {
        if(topic === eventsTopic && currentConnection) {
          const event:MQTTFrigateEvent = JSON.parse(message.toString())
          handleFrigateEvent(currentConnection, event, logger)
        } else if(currentConnection) {
          const occupancyTopic = findOccupancyTopic(currentConnection.devices, topic)
          if(occupancyTopic) {
            handleOccupancyChange(currentConnection, {
              cameraName: occupancyTopic.cameraName,
              trackedObject: occupancyTopic.trackedObject,
              count: parseInt(message.toString(), 10)
            }, logger)
          }
        }
      } catch(err) {
        logger.error('Failed to parse MQTT message as JSON')
        logger.error(err)
      }
    })
    
    client.on('connect', async (ack) => {
      logger.info({msg: 'Client connected', mqtt: {username: mqttConfig.username, host: mqttConfig.host, port: mqttConfig.port}, ack})
      try {
        await client.unsubscribeAsync(eventsTopic)
      } catch(err) {
        logger.info(`Failed to unsubscribe from ${eventsTopic}.`)
      }
      try {
        await client.subscribeAsync(eventsTopic)
      } catch(err) {
        logger.error(`Failed to subscribe to ${eventsTopic}.`)
        logger.error(err)
        return
      }
      logger.info(`Listening to topic ${eventsTopic} on MQTT server ${mqttConfig.username}@${mqttConfig.host}:${mqttConfig.port}`)
    })

  } else if(!currentConnection.client.connected) {
    logger.info('Reusing MQTT server connection but waiting for client to connect')
    await new Promise<void>((resolve) => {
      currentConnection!.client.on('connect', () => {
        resolve()
      })
    })
  } else {
    logger.info('Reusing MQTT server connection')
  }
  return currentConnection
}

function buildOccupancyTopic(prefix:string, cameraName:string, trackedObject:string) {
  return `${prefix}/${cameraName}/${trackedObject}`
}
let cnt=0

export const listenToEvents = async (config: {
  mqttConfig:IClientOptions,
  mqttTopicPrefix:string,
  cameraName:string,
  trackedObjects:string[],
  eventHandler:FrigateNVREventHandler,
  occupancyHandler:FrigateNVROccupancyHandler,
  logger: Logger
}) => {

  config.logger.info(`Camera ${config.cameraName} connecting to MQTT`)
  const connection = await connectToMQTTServer(config.mqttConfig, config.mqttTopicPrefix, config.logger)

  const occupancyTopics = [{
    topic: buildOccupancyTopic(config.mqttTopicPrefix, config.cameraName, 'person'),
    cameraName: config.cameraName,
    trackedObject: 'person'
  }]

  const device = {
    cameraName: config.cameraName,
    trackedObjects: config.trackedObjects,
    occupancyTopics: occupancyTopics,
    eventHandler: config.eventHandler,
    occupancyHandler: config.occupancyHandler
  }
  for(let occupancyTopic of occupancyTopics) {
    config.logger.info(`Camera ${config.cameraName} listening to occupancy topic ${occupancyTopic.topic}`)
    await connection.client.subscribeAsync(occupancyTopic.topic)
  }
  connection.devices.push(device)
}

export const stopListeningToEvents = async (cameraName:string) => {
  if(currentConnection) {
    for(let j=currentConnection.devices.length - 1 ; j>=0 ; j--) {
      const device = currentConnection.devices[j]

      for(let occupancyTopic of device.occupancyTopics) {
        await currentConnection.client.unsubscribeAsync(occupancyTopic.topic)
      }
      if(device.cameraName === cameraName) {
        currentConnection.devices.splice(j, 1)
      }
    }
    if(currentConnection.devices.length === 0) {
      currentConnection.client.end()
      currentConnection = null
    }
  }
}

export const isEventOngoing = async(args: {frigateURL:string, eventId:string, logger:Logger}):Promise<boolean> => {
  const url = `${args.frigateURL}/api/events/${args.eventId}`
  try {
    const res = await axios({
      method: 'get',
      url: url,
      responseType: 'json'
    })
    if(res.status !== 200) {
      const err = new Error(`Failed to fetch image ${url}. httpStatusCode=${res.status}. ${res.statusText}`)
      args.logger.error(err)
      return false
    } else {
      return !res.data.end_time
    }
  } catch(err) {
    args.logger.error(err)
    return false
  }
}