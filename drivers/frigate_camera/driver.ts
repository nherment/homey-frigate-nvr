import Homey from 'homey';
import { PairSession } from 'homey/lib/Driver';
import axios from 'axios';
import { FrigateNVRConfig } from './types';
import mqtt from 'mqtt';

class MyDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('MyDriver has been initialized');
  }


  async onPair(session: PairSession): Promise<void> {
    this.log('showing view')
    await session.showView('frigate_hostname')
    let frigateConfig:FrigateNVRConfig|null = null
    let frigateAddress:string|null = null

    const connect = async(address:string) => {
      try {
        const response = await axios.get<FrigateNVRConfig>(`${address}/api/config`, {
          timeout: 30000
        })
        if(!response || response.status !== 200) {
          const errorMessage = `Failed to reach FrigateNVR at <url>. Received error ${response.status} - ${response.statusText}`
          this.log('Emitting error ' + errorMessage)
          await session.emit('error', errorMessage)
        } else {
          frigateConfig = response.data

          await session.showView('list_devices')
        }
      } catch(err:any) {
        await session.emit('error', err.message)
      }

    }

    session.setHandler('connect', async (address) => {
      this.log('Received connect event '+ address)
      frigateAddress = address
      await connect(address)
    })

    session.setHandler('list_devices', async () => {
      if(!frigateConfig || !frigateAddress) {
        return []
      }
      const mqttConfig = frigateConfig.mqtt
      const cameras = frigateConfig.cameras
      const trackedObjects = frigateConfig.objects?.track || ['person']

      const devices = Object.keys(cameras).map(cameraName => {
        return {
          name: cameraName,
          data: {
            id: `frigate-nvr-${cameraName}`
          },
          store: {
            cameraName: cameraName,
            mqttEnabled: mqttConfig.enabled,
            mqttHost: mqttConfig.host,
            mqttPort: mqttConfig.port,
            mqttTopicPrefix: mqttConfig.topic_prefix,
            trackedObjects: trackedObjects.join(',')
          },
          settings: {
            frigateURL: frigateAddress,
            mqttUsername: mqttConfig.user,
            mqttPassword: mqttConfig.password
          },
        }
      });

      if(frigateConfig.birdseye.enabled) {
        devices.push({
          name: 'Birdseye',
          data: {
            id: `frigate-nvr-birdseye`
          },
          store: {
            cameraName: 'birdseye',
            mqttEnabled: mqttConfig.enabled,
            mqttHost: mqttConfig.host,
            mqttPort: mqttConfig.port,
            mqttTopicPrefix: mqttConfig.topic_prefix,
            trackedObjects: trackedObjects.join(',')
          },
          settings: {
            frigateURL: frigateAddress,
            mqttUsername: mqttConfig.user,
            mqttPassword: mqttConfig.password
          },
        })
      }
      devices.sort((a, b) => {
        if(a.name < b.name) {
          return -1
        } else if (a.name > b.name) {
          return 1
        } else {
          return 0
        }
      })
      console.log(JSON.stringify(devices))
      return devices
    })
  }

}

module.exports = MyDriver;
