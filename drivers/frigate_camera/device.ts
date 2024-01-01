import Homey from 'homey';

import { IClientOptions } from 'mqtt';

import { MQTTFrigateEvent, MQTTOccupancy } from './types';
import { fetchFrigateConfig, getEventSnapshotImage, getEventThumbnailImage, listenToEvents, stopListeningToEvents, getCameraLatestImage, getCameraObjectSnapshotImage, getCameraObjectThumbnailImage } from './frigateAPI';

interface Occupancy {
  [key:string]: number
}

interface DeviceSettings {
  frigateURL: string
  detectionThrottle: number
  mqttUsername: string
  mqttPassword: string
}

interface DeviceStore {
  cameraName: string
  trackedObjects: string
  mqttHost: string
  mqttPort: number
  mqttTopicPrefix: string
  mqttEnabled: boolean
}

function shouldTriggerObjectDetection(event:MQTTFrigateEvent):boolean {
  return !event.after.false_positive &&
    event.after.has_snapshot &&
    event.after.has_clip &&
    (event.type === 'new' || event.type === 'update')
}

class MyDevice extends Homey.Device {

  frigateURL:string|null = null
  frigateCameraName:string|null = null
  trackedObjects:string[] = []
  occupancy:Occupancy = {}
  detectionThrottleInMilliseconds = 60000
  lastTrigger:number = 0

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    const settings = this.getSettings() as DeviceSettings
    const store = this.getStore() as DeviceStore
    this.frigateURL = settings.frigateURL
    this.detectionThrottleInMilliseconds = settings.detectionThrottle * 1000
    this.frigateCameraName = store.cameraName
    this.trackedObjects = store.trackedObjects.split(',')

    await this.unsetWarning()

    await Promise.all([
      this._setupImages(),
      this._connectToMQTT()
    ])

    this.log(`Camera ${this.frigateCameraName} has been initialized`);
  }

  async _setupImages() {

    if(!this.frigateURL) {
      return this.setWarning('Could not initialize device because the frigateURL setting is empty')
    }
    if(!this.frigateCameraName) {
      return this.setWarning('Could not initialize device because the cameraName stored data is empty')
    }

    const latestImage = await getCameraLatestImage({
      homey: this.homey,
      frigateURL: this.frigateURL,
      cameraName: this.frigateCameraName
    })

    this.setCameraImage(`${this.frigateCameraName} - latest`, this.frigateCameraName, latestImage)

    this.homey.flow.createToken(`${this.frigateCameraName} latest`, {
      type: "image",
      title: `${this.getName()} - latest`,
      value: latestImage
    }).catch(err => {
      this.log(err)
    })

    if(this.frigateCameraName !== 'birdseye') {

      for(let trackedObject of this.trackedObjects) {
        const [snapshot, thumbnail] = await Promise.all([
          getCameraObjectSnapshotImage({
            homey: this.homey,
            frigateURL: this.frigateURL,
            cameraName: this.frigateCameraName,
            object: trackedObject
          }),
          getCameraObjectThumbnailImage({
            homey: this.homey,
            frigateURL: this.frigateURL,
            cameraName: this.frigateCameraName,
            object: trackedObject
          })
        ])

        this.homey.flow.createToken(`${this.frigateCameraName} ${trackedObject} - snapshot`, {
          type: "image",
          title: `${this.getName()} - ${trackedObject} - snapshot`,
          value: snapshot
        }).catch(err => {
          this.log(err)
        })

        this.homey.flow.createToken(`${this.frigateCameraName} ${trackedObject} - thumbnail`, {
          type: "image",
          title: `${this.getName()} - ${trackedObject} - thumbnail`,
          value: thumbnail
        }).catch(err => {
          this.log(err)
        })
      }
    }

  }

  _throttle() {
    return Date.now() <= (this.lastTrigger + this.detectionThrottleInMilliseconds)
  }

  _recordTriggerForThrottling() {
    this.lastTrigger = Date.now()
  }

  async _mqttHandleEvent(event:MQTTFrigateEvent) {

    const eventId = event.after.id
    if(shouldTriggerObjectDetection(event) && !this._throttle()) {
      this._recordTriggerForThrottling()

      this.log(`Object detected ${this.frigateCameraName}/${event.after.label}. EventId=${eventId}`)

      const [snapshot, thumbnail] = await Promise.all([
        getEventSnapshotImage({homey: this.homey, frigateURL: this.frigateURL!, eventId}),
        getEventThumbnailImage({homey: this.homey, frigateURL: this.frigateURL!, eventId})
      ])

      let clipURL:string = `${this.frigateURL}/api/events/${eventId}/clip.mp4`
      this.homey.flow.getDeviceTriggerCard('object-detected').trigger(this, {
        'object': event.after.label,
        'cameraName': event.after.camera,
        'snapshot': snapshot,
        'thumbnail': thumbnail,
        'clipURL': clipURL,
        'eventId': event.after.id
      })


      this.homey.flow.getTriggerCard('all-cameras-object-detected').trigger({
        'object': event.after.label,
        'cameraName': event.after.camera,
        'snapshot': snapshot,
        'thumbnail': thumbnail,
        'clipURL': clipURL,
        'eventId': event.after.id
      })
    }
  }

  async _mqttHandleOccupancyChange(occupancy: MQTTOccupancy) {
    // this.log(`Occupancy ${this.cameraName}/${occupancy.trackedObject}=${occupancy.count}`)
    this.occupancy[occupancy.trackedObject] = occupancy.count
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: unknown;
    newSettings: unknown;
    changedKeys: string[];
  }): Promise<string | void> {
    const newS = newSettings as DeviceSettings
    if(changedKeys.includes('frigateURL')) {
      this._syncFrigateData(newS)
    } else if (changedKeys.includes('mqttUsername') || changedKeys.includes('mqttPassword')) {
      await this._disconnectFromMQTT()
      await this._connectToMQTT()
    }
    this.log("MyDevice settings where changed");
  }

  async _syncFrigateData(settings:DeviceSettings) {
    const frigateConfig = await fetchFrigateConfig(settings.frigateURL)
    const newCameraConfig = frigateConfig.cameras[this.frigateCameraName!]
    if(!newCameraConfig) {
      this.setUnavailable(`Could not find camera ${this.frigateCameraName} in Frigate instance ${settings.frigateURL}. Either remove the camera and install a new one or provide a corrected frigate URL in this device's settings`)
    } else {
      const trackedObjects = frigateConfig.objects?.track || ['person']
      this.setStoreValue('trackedObjects', trackedObjects.join(','))

      if(frigateConfig.mqtt) {
        this.setStoreValue('mqttEnabled', frigateConfig.mqtt.enabled)
        this.setStoreValue('mqttHost', frigateConfig.mqtt.host)
        this.setStoreValue('mqttPort', frigateConfig.mqtt.port)
        this.setStoreValue('mqttTopicPrefix', frigateConfig.mqtt.topic_prefix)
        await this._disconnectFromMQTT()
        await this._connectToMQTT()
      }
    }
  }

  async _connectToMQTT() {

    if(this.frigateCameraName === 'birdseye') {
      return
    }
    const settings = this.getSettings() as DeviceSettings
    const store = this.getStore() as DeviceStore
    if(store.mqttEnabled) {
      const mqttConfig:IClientOptions = {}
      if(store.mqttHost) {
        mqttConfig.host = store.mqttHost
      }
      if(store.mqttPort) {
        mqttConfig.port = store.mqttPort
      }
      if(settings.mqttUsername) {
        mqttConfig.username = settings.mqttUsername
      }
      if(settings.mqttPassword) {
        mqttConfig.password = settings.mqttPassword
      }

      try {
        await listenToEvents({
          mqttConfig,
          cameraName: this.frigateCameraName!,
          trackedObjects: this.trackedObjects,
          mqttTopicPrefix: store.mqttTopicPrefix,
          eventHandler: this._mqttHandleEvent.bind(this),
          occupancyHandler: this._mqttHandleOccupancyChange.bind(this)
        })
        await this.unsetWarning()
      } catch(err:any) {
        this.log(err)
        this.setWarning(`Failed to connect to MQTT server. ${err.message}`)
      }
    }
  }

  async _disconnectFromMQTT() {
    await stopListeningToEvents(this.frigateCameraName!)
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    await this._disconnectFromMQTT()
  }

}

module.exports = MyDevice;
