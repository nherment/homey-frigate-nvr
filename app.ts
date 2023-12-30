'use strict';

import Homey from 'homey';
import {v2 as cloudinary} from 'cloudinary';
import axios from 'axios';

cloudinary.config({
});
const { pipeline } = require('node:stream/promises');

let cnt = 0

class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    const shareVideoCard = this.homey.flow.getActionCard("share-video");
    shareVideoCard.registerRunListener(async (args:{localURL:string}) => {
      this.log(`Uploading video to cloudinary ${args.localURL}`)
      cnt++
      const clipId = `clip-${cnt}`
      const uploadStream = cloudinary.uploader.upload_stream({
        resource_type: "video",
        public_id: clipId,
        use_filename_as_display_name: true,
        overwrite: true
      });
      uploadStream.on('end', () => {
        console.log('File uploaded', clipId, args.localURL)
      })
      const res = await axios({
        method: 'get',
        url: args.localURL,
        responseType: 'stream'
      })
      if(res.status !== 200) {
        throw new Error('Invalid response')
      }
      return pipeline(res.data, uploadStream)
    })
    this.log('MyApp has been initialized');
  }

}

module.exports = MyApp;
