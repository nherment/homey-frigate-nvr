import Homey, { Image } from 'homey';

import mqtt, { IClientOptions } from 'mqtt';

import { MQTTFrigateEvent, MQTTOccupancy } from './types';
import { getLatestImage, getSnapshotImage, getThumbnailImage, listenToEvents, stopListeningToEvents } from './frigateAPI';

interface Occupancy {
  [key:string]: number
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
  triggerThrottling = false

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {

    this.frigateURL = this.getSetting('frigateURL')
    this.cameraName = this.getStoreValue('cameraName')
    this.trackedObjects = this.getStoreValue('trackedObjects').split(',')


    if(!this.frigateURL) {
      throw new Error('Could not initialize device because the frigateURL setting is empty')
    }
    if(!this.cameraName) {
      throw new Error('Could not initialize device because the cameraName stored data is empty')
    }

    const image = await getLatestImage(this.homey, this.frigateURL, this.cameraName)
    this.setCameraImage(this.cameraName + '-latest', this.cameraName, image)

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

  async _mqttHandleEvent(event:MQTTFrigateEvent) {

    const eventId = event.after.id
    if(shouldTriggerObjectDetection(event) && !this.triggerThrottling) {
      this.triggerThrottling = true
      setTimeout(() => {
        this.triggerThrottling = false
      }, 60000)

      this.log(`Object detected ${this.cameraName}/${event.after.label}. EventId=${eventId}`)

      const [snapshot, thumbnail] = await Promise.all([
        getSnapshotImage({homey: this.homey, frigateURL: this.frigateURL!, eventId}),
        getThumbnailImage({homey: this.homey, frigateURL: this.frigateURL!, eventId})
      ])
      let clipURL:string = `${this.frigateURL}/api/events/${eventId}/clip.mp4`

      const objDetectedTrigger = this.homey.flow.getDeviceTriggerCard('object-detected')
      objDetectedTrigger.trigger(this, {
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
