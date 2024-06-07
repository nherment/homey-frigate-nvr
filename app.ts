'use strict';

import Homey from 'homey';
const { Log } = require('homey-log');

class MyApp extends Homey.App {
  homeyLog:any;
  async onInit() {
    this.homeyLog = new Log({ homey: this.homey });
  }
}

module.exports = MyApp;
