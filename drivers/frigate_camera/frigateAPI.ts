import { Image } from "homey";
import Homey from "homey/lib/Homey";
import axios from "axios";
import { FrigateNVREventHandler, FrigateNVROccupancyHandler, MQTTFrigateEvent, MQTTOccupancy } from "./types";
import mqtt, { IClientOptions, MqttClient } from 'mqtt';
import { pipeline } from 'node:stream/promises'
import { Writable } from "node:stream";

export const getLatestImage = async(homey:Homey, frigateURL:string, cameraName:string):Promise<Image> => {

  const image = await homey.images.createImage()
  image.setStream(async (stream:Writable) => {
    const res = await axios({
      method: 'get',
      url: `${frigateURL}/api/${cameraName}/latest.jpg`,
      responseType: 'stream'
    })
    if(res.status !== 200) {
      throw new Error('Invalid response')
    }
    return res.data.pipe(stream)
  })
  return image
}

export const getSnapshotImage = (args:{homey:Homey, frigateURL:string, eventId:string}):Promise<Image> => {
  return getEventImage({...args, type: 'snapshot'})
}

export const getThumbnailImage = (args:{homey:Homey, frigateURL:string, eventId:string}):Promise<Image> => {
  return getEventImage({...args, type: 'thumbnail'})
}

export const getEventImage = async(args:{homey:Homey, frigateURL:string, eventId:string, type:'thumbnail'|'snapshot'}):Promise<Image> => {
  const url = `${args.frigateURL}/api/events/${args.eventId}/${args.type}.jpg`
  const image = await args.homey.images.createImage()
  image.setStream(async (stream:Writable) => {
    const res = await axios({
      method: 'get',
      url: url,
      responseType: 'stream'
    })
    if(res.status !== 200) {
      const err = new Error(`Failed to fetch image ${url}. httpStatusCode=${res.status}. ${res.statusText}`)
      console.error(err)
    } else {
      res.data.pipe(stream)
    }
  })
  return image
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

const connections:MQTTConnection[] = []

const handleFrigateEvent = async (connection:MQTTConnection, event:MQTTFrigateEvent) => {
  for(let device of connection.devices) {
    if(event.after.camera === device.cameraName) {
      try {
        device.eventHandler(event).catch(err => {
          console.error(`Asynchronous error while executing event listener for camera ${device.cameraName}`)
          console.error(err)
        })
        return; // Expect a single device per camera
      } catch(err) {
        console.error(`Synchronous error while executing event listener for camera ${device.cameraName}`)
        console.error(err)
      }
    }
  }
}
const handleOccupancyChange = async (connection:MQTTConnection, occupancy:MQTTOccupancy) => {
  for(let device of connection.devices) {
    if(occupancy.cameraName === device.cameraName) {
      try {
        device.occupancyHandler(occupancy).catch(err => {
          console.error(`Asynchronous error while executing event listener for camera ${device.cameraName}`)
          console.error(err)
        })
        return; // Expect a single device per camera
      } catch(err) {
        console.error(`Synchronous error while executing event listener for camera ${device.cameraName}`)
        console.error(err)
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

const connectToMQTTServer = async (mqttConfig:IClientOptions, mqttTopicPrefix:string):Promise<MQTTConnection> => {
  mqttConfig.clientId = 'homey-frigate-nvr'
  let currentConnection = connections.find(conn => {
    return conn.config.host == mqttConfig.host &&
      conn.config.port == mqttConfig.port &&
      conn.topicPrefix == mqttTopicPrefix &&
      conn.config.username == mqttConfig.username &&
      conn.config.password == mqttConfig.password
  })

  if(!currentConnection) {

    console.log(`Creating new connection to MQTT server ${mqttConfig.username}@${mqttConfig.host}:${mqttConfig.port}`)

    const client = mqtt.connect(`mqtt://${mqttConfig.host}:${mqttConfig.port}`, mqttConfig)

    currentConnection = {
      client: client,
      config: mqttConfig,
      topicPrefix: mqttTopicPrefix,
      devices: []
    }

    connections.push(currentConnection!)

    client.on('connect', async () => {
      const eventsTopic = `${mqttTopicPrefix}/events`
      await client.subscribeAsync(eventsTopic)
      console.log(`Listening to topic ${eventsTopic}`)

      client.on('message', async (topic, message) => {
        try {
          if(topic === eventsTopic && currentConnection) {
            const event:MQTTFrigateEvent = JSON.parse(message.toString())
            handleFrigateEvent(currentConnection, event)
          } else if(currentConnection) {
            const occupancyTopic = findOccupancyTopic(currentConnection.devices, topic)
            if(occupancyTopic) {
              handleOccupancyChange(currentConnection, {
                cameraName: occupancyTopic.cameraName,
                trackedObject: occupancyTopic.trackedObject,
                count: parseInt(message.toString(), 10)
              })
            }
          }
        } catch(err) {
          console.error('Failed to parse MQTT message as JSON')
        }
      })
    })

  } else if(!currentConnection.client.connected) {
    console.log('Reusing MQTT server connection but waiting for client to connect')
    await new Promise<void>((resolve) => {
      currentConnection!.client.on('connect', () => {
        resolve()
      })
    })
  } else {
    console.log('Reusing MQTT server connection')
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
  occupancyHandler:FrigateNVROccupancyHandler
}) => {

  const connection = await connectToMQTTServer(config.mqttConfig, config.mqttTopicPrefix)
  const occupancyTopics = []

  for(let trackedObject of config.trackedObjects) {
    occupancyTopics.push({
      topic: buildOccupancyTopic(config.mqttTopicPrefix, config.cameraName, trackedObject),
      cameraName: config.cameraName,
      trackedObject
    })
  }

  const device = {
    cameraName: config.cameraName,
    trackedObjects: config.trackedObjects,
    occupancyTopics: occupancyTopics,
    eventHandler: config.eventHandler,
    occupancyHandler: config.occupancyHandler
  }
  for(let occupancyTopic of occupancyTopics) {
    console.log(`Listening to occupancy topic ${occupancyTopic.topic}`)
    await connection.client.subscribeAsync(occupancyTopic.topic)
  }
  connection.devices.push(device)
}

export const stopListeningToEvents = async (cameraName:string) => {
  for(let i=connections.length - 1 ; i>=0 ; i--) {
    const connection = connections[i]
    for(let j=connection.devices.length - 1 ; j>=0 ; j--) {
      const device = connection.devices[j]

      for(let occupancyTopic of device.occupancyTopics) {
        await connection.client.unsubscribeAsync(occupancyTopic.topic)
      }
      if(device.cameraName === cameraName) {
        connection.devices.splice(j, 1)
      }
    }
    if(connection.devices.length === 0) {
      connection.client.end()
      connections.splice(i, 1)
    }
  }
}