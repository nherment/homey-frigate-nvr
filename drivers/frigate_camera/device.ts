import Homey, { FlowToken, Image } from 'homey';

import { IClientOptions } from 'mqtt';

import { MQTTFrigateEvent, MQTTOccupancy } from './types';
import * as frigateAPI from './frigateAPI';
import { Logger, getLogger } from '../../utils/logging';
import path from 'path';

interface DeviceSettings {
  frigateURL: string
  detectionThrottle: number
  mqttUsername: string
  mqttPassword: string
  uniqueEvents: boolean
}

interface DeviceStore {
  cameraName: string
  trackedObjects: string
  mqttHost: string
  mqttPort: number
  mqttTopicPrefix: string
  mqttEnabled: boolean
}

function capitalize(str:string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

class Camera extends Homey.Device {

  frigateURL:string|null = null
  frigateCameraName:string|null = null
  trackedObjects:string[] = []
  detectionThrottleInMilliseconds = 60000
  lastTrigger:number = 0
  latestImage:Image|null = null
  activeEvents:Map<string, Set<string>> = new Map<string, Set<string>>()
  logger:Logger|undefined
  snapshotRequired:boolean = false
  uniqueEvents:boolean = true

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    const settings = this.getSettings() as DeviceSettings
    const store = this.getStore() as DeviceStore
    this.frigateURL = settings.frigateURL
    this.detectionThrottleInMilliseconds = settings.detectionThrottle * 1000
    this.uniqueEvents = settings.uniqueEvents || true
    this.frigateCameraName = store.cameraName
    this.trackedObjects = store.trackedObjects.split(',').map(s=>s.trim())

    const fileLoggingEnabled = this.homey.settings.get('loggingEnabled') || false
    const logLevel = this.homey.settings.get('logLevel') || false
    this.logger = getLogger(this.homey, fileLoggingEnabled, logLevel)
    this.snapshotRequired = this.homey.settings.get('snapshotRequired') || false

    await this._setupImages()
    await this._setupCapabilities()
    await this.unsetWarning()
    await this._connectToMQTT()

    this.logger.info(`Camera ${this.frigateCameraName} has been initialized`);
  }

  async _setupCapabilities() {
    const capabilities = this.getCapabilities()
    if(this.frigateCameraName === 'birdseye') {
      if(capabilities.includes('occupancy')) {
        await this.removeCapability('occupancy')
      }
      if(capabilities.includes('person_detected')) {
        await this.removeCapability('person_detected')
      }
      // if(!capabilities.includes('rtsp_feed')) {
      //   await this.addCapability('rtsp_feed')
      // }
    }
  }

  async _setupImages() {

    if(!this.frigateURL) {
      return this.setWarning('Could not initialize device because the frigateURL setting is empty')
    }
    if(!this.frigateCameraName) {
      return this.setWarning('Could not initialize device because the cameraName stored data is empty')
    }

    if(!this.latestImage) {
      this.latestImage = await this.homey.images.createImage()
    }
    await frigateAPI.getCameraLatestImage({
      image: this.latestImage,
      frigateURL: this.frigateURL,
      cameraName: this.frigateCameraName
    })

    this.setCameraImage('latest', 'Live', this.latestImage)

    if(this.frigateCameraName !== 'birdseye') {

      for(let trackedObject of this.trackedObjects) {

        const snapshotImage = await this.homey.images.createImage()

        frigateAPI.getCameraObjectSnapshotImage({
          image: snapshotImage,
          frigateURL: this.frigateURL,
          cameraName: this.frigateCameraName,
          object: trackedObject
        })

        this.setCameraImage(trackedObject, capitalize(trackedObject), snapshotImage)

      }
    }

  }

  _shouldThrottle():boolean {
    if(this.detectionThrottleInMilliseconds <= 0) {
      return false
    }
    return Date.now() <= (this.lastTrigger + this.detectionThrottleInMilliseconds)
  }

  _recordTriggerForThrottling() {
    this.lastTrigger = Date.now()
  }

  _shouldTriggerObjectDetection(event:MQTTFrigateEvent):boolean {
    const eventInfo = {
      camera: event.after.camera,
      msg: 'Event ignored',
      reason: '',
      label: event.after.label,
      type: event.type,
      id: event.before?.id || event.after?.id
    }
    if(this.snapshotRequired && !event.after.has_snapshot) {
      eventInfo.reason = 'no_snapshot'
      this.logger?.info(eventInfo)
      return false
    }
    if(event.after.false_positive) {
      eventInfo.reason = 'false_positive'
      this.logger?.info(eventInfo)
      return false
    }
    if(event.before.stationary && event.after.stationary) {
      eventInfo.reason = 'stationary'
      this.logger?.info(eventInfo)
      return false
    }
    if(event.type !== 'new' && event.type !== 'update') {
      eventInfo.reason = 'neither_new_nor_update'
      this.logger?.info(eventInfo)
      return false
    }
    if(!event.before.label && !event.after.label) {
      eventInfo.reason = 'no_label'
      this.logger?.info(eventInfo)
      return false
    }

    return true
  }

  async _setEventActive(trackedObject:string, eventId:string) {
    if(!this.activeEvents.has(trackedObject)) {
      this.activeEvents.set(trackedObject, new Set<string>())
    }
    const events = this.activeEvents.get(trackedObject)
    if(!events?.has(eventId)) {
      events?.add(eventId)
      this._continuousCheckIfEventStillOngoing(trackedObject, eventId)
    }
    if(trackedObject === 'person') {
      await this.setCapabilityValue('person_detected', true)
    }
  }

  async _setEventEnded(trackedObject:string, eventId:string) {
    if(!this.activeEvents.has(trackedObject)) {
      return
    }
    const events = this.activeEvents.get(trackedObject)
    events?.delete(eventId)
    if(events?.size === 0) {
      this.activeEvents.delete(trackedObject)
      if(trackedObject === 'person') {
        await this.setCapabilityValue('person_detected', false)
      }
    }
  }

  _isEventActive(trackedObject:string, eventId:string) {
    return this.activeEvents.get(trackedObject)?.has(eventId)
  }

  async _clearAllActiveEvents() {
    this.activeEvents.clear()
    await this.setCapabilityValue('person_detected', false)
  }

  async _continuousCheckIfEventStillOngoing(trackedObject:string, eventId:string) {
    setTimeout(async () => {
      if(this._isEventActive(trackedObject, eventId)) {
        const ongoing = await frigateAPI.isEventOngoing({frigateURL:this.frigateURL!, eventId, logger: this.logger!})
        if(ongoing) {
          await this._continuousCheckIfEventStillOngoing(trackedObject, eventId)
        } else {
          await this._setEventEnded(trackedObject, eventId)
        }
      }
    }, 10000)
  }

  async _mqttHandleEvent(event:MQTTFrigateEvent) {

    const eventId = event.after.id
    const trackedObject = event.after.label || event.before.label

    if(!trackedObject) {
      return
    }

    if(this._shouldTriggerObjectDetection(event) && (!this._isEventActive(trackedObject, eventId) || !this.uniqueEvents)) {
      await this._setEventActive(trackedObject, eventId)
      // console.log(`${(new Date()).toUTCString()} - ${this.frigateCameraName} - ${trackedObject} - ${eventId} - ${JSON.stringify(event)}`)
      if(this._shouldThrottle()) {
        this.logger?.info({ camera: this.frigateCameraName, msg: 'Event ignored', trackedObject, id:eventId, reason: 'throttling'})
      } else {
        this._recordTriggerForThrottling()

        this.logger?.info({ camera: this.frigateCameraName, msg: 'Object detected', trackedObject, id:eventId})

        const snapshot = await this.homey.images.createImage()
        const thumbnail = await this.homey.images.createImage()

        if(event.after.has_snapshot) {
          await Promise.all([
            frigateAPI.getEventSnapshotImage({image: snapshot, frigateURL: this.frigateURL!, eventId}),
            frigateAPI.getEventThumbnailImage({image: thumbnail, frigateURL: this.frigateURL!, eventId})
          ])
        } else {
          snapshot.setPath(path.join(__dirname, '../../assets/images/placeholder_snapshot.jpg'));
          thumbnail.setPath(path.join(__dirname, '../../assets/images/placeholder_thumbnail.jpg'));
        }

        let clipURL:string = ''
        if(event.after.has_clip) {
          clipURL = `${this.frigateURL}/api/events/${eventId}/clip.mp4`
        }

        this.homey.flow.getDeviceTriggerCard('object-detected').trigger(this, {
          'object': trackedObject,
          'cameraName': event.after.camera,
          'snapshot': snapshot,
          'thumbnail': thumbnail,
          'clipURL': clipURL,
          'eventId': event.after.id,
          'current_zones': (event.after.current_zones || []).join(','),
          'entered_zones': (event.after.entered_zones || []).join(',')
        })

        this.homey.flow.getTriggerCard('all-cameras-object-detected').trigger({
          'object': trackedObject,
          'cameraName': event.after.camera,
          'snapshot': snapshot,
          'thumbnail': thumbnail,
          'clipURL': clipURL,
          'eventId': event.after.id,
          'current_zones': (event.after.current_zones || []).join(','),
          'entered_zones': (event.after.entered_zones || []).join(',')
        })
      }
    } else if(trackedObject && (event.type === 'end' || event.after.false_positive)) {
      this.logger?.info({camera: this.frigateCameraName, msg: 'Ending event', false_positive: event.after.false_positive, id: event.after.id})
      await this._setEventEnded(trackedObject, eventId)
    }
  }


  async _mqttHandleOccupancyChange(occupancy: MQTTOccupancy) {
    if(occupancy.trackedObject === 'person') {
      this.setCapabilityValue('occupancy', occupancy.count)
    }
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
    this.logger!.info("MyDevice settings where changed");
  }

  async _syncFrigateData(settings:DeviceSettings) {
    const frigateConfig = await frigateAPI.fetchFrigateConfig(settings.frigateURL)
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
        await frigateAPI.listenToEvents({
          mqttConfig,
          cameraName: this.frigateCameraName!,
          trackedObjects: this.trackedObjects,
          mqttTopicPrefix: store.mqttTopicPrefix,
          eventHandler: this._mqttHandleEvent.bind(this),
          occupancyHandler: this._mqttHandleOccupancyChange.bind(this),
          logger: this.logger!
        })
        await this.unsetWarning()
      } catch(err:any) {
        this.log(err)
        this.setWarning(`Failed to connect to MQTT server. ${err.message}`)
      }
    }
  }

  async _disconnectFromMQTT() {
    await frigateAPI.stopListeningToEvents(this.frigateCameraName!)
    await this._clearAllActiveEvents()
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    await this._disconnectFromMQTT()
  }

}

module.exports = Camera;
