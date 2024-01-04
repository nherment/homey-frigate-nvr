import Homey from "homey/lib/Homey";

export const createCameraRtspFeedToken = async(homey:Homey, url:string) => {
    await homey.flow.createToken("rtsp_feed", {
      type: "text",
      title: "My Token",
      value: url
    });
}