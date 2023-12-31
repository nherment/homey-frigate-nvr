import Homey, { Image } from 'homey';

import mqtt, { IClientOptions } from 'mqtt';

import { MQTTFrigateEvent, MQTTOccupancy } from './types';
import { getLatestImage, getSnapshotImage, getThumbnailImage, listenToEvents, stopListeningToEvents } from './frigateAPI';

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
  mqttHost
  mqttPort
  mqttTopicPrefix
  mqttEnabled
}

function shouldTriggerObjectDetection(event:MQTTFrigateEvent):boolean {
  return !event.after.false_positive &&
    event.after.has_snapshot &&
    event.after.has_clip &&
    (event.type === 'new' || event.type === 'update')
}

class MyDevice extends Homey.Device {

  frigateURL:string|null = null
  cameraName:string|null = null
  trackedObjects:string[] = []
  occupancy:Occupancy = {}
  detectionThrottleInMilliseconds = 60000
  lastTrigger:number = 0

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {

    this.frigateURL = this.getSetting('frigateURL')
    this.detectionThrottleInMilliseconds = this.getSetting('detectionThrottle') * 1000
    this.cameraName = this.getStoreValue('cameraName')
    this.trackedObjects = this.getStoreValue('trackedObjects').split(',')


    if(!this.frigateURL) {
      throw new Error('Could not initialize device because the frigateURL setting is empty')
    }
    if(!this.cameraName) {
      throw new Error('Could not initialize device because the cameraName stored data is empty')
    }
    console.log(this.frigateURL, this.cameraName, this.trackedObjects)
    const image = await getLatestImage(this.homey, this.frigateURL, this.cameraName)
    this.setCameraImage(this.cameraName + '-latest', this.cameraName, image)

    this.homey.flow.createToken(`${this.cameraName} latest`, {
      type: "image",
      title: `${this.cameraName} - latest`,
      value: image
    }).catch(err => {
      this.log(err)
    })

    if(this.getStoreValue('mqttEnabled')) {
      const mqttConfig:IClientOptions = {}
      if(this.getStoreValue('mqttHost')) {
        mqttConfig.host = this.getStoreValue('mqttHost')
      }
      if(this.getStoreValue('mqttPort')) {
        mqttConfig.port = this.getStoreValue('mqttPort')
      }
      if(this.getSetting('mqttUsername')) {
        mqttConfig.username = this.getSetting('mqttUsername')
      }
      if(this.getSetting('mqttPassword')) {
        mqttConfig.password = this.getSetting('mqttPassword')
      }
      const mqttTopicPrefix = this.getStoreValue('mqttTopicPrefix')

      listenToEvents({
        mqttConfig,
        cameraName: this.cameraName,
        trackedObjects: this.trackedObjects,
        mqttTopicPrefix,
        eventHandler: this._mqttHandleEvent.bind(this),
        occupancyHandler: this._mqttHandleOccupancyChange.bind(this)
      })
    }

    this.log(`Camera ${this.cameraName} has been initialized`);
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

      this.log(`Object detected ${this.cameraName}/${event.after.label}. EventId=${eventId}`)

      const [snapshot, thumbnail] = await Promise.all([
        getSnapshotImage({homey: this.homey, frigateURL: this.frigateURL!, eventId}),
        getThumbnailImage({homey: this.homey, frigateURL: this.frigateURL!, eventId})
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


      this.homey.flow.getTriggerCard('object-detected').trigger({
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
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    if(newSettings[])
    // TODO: update stored data if frigateURL has changed.
    // TODO: reconnect to MQTT if username/pwd have changed
    this.log("MyDevice settings where changed");
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    await stopListeningToEvents(this.cameraName!)
  }

}

module.exports = MyDevice;
