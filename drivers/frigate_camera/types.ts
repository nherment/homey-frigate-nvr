export interface MQTTConfig {
  client_id: string
  enabled: boolean
  host: string
  port: number
  topic_prefix: string
  user: string
  password: string
}

export interface FrigateNVRConfig {
  birdseye: {
    enabled: boolean
    height: number
  }
  cameras: {
    [key:string]: {
      birdseye: {
        enabled: boolean
      }
      enabled: boolean
    }
  }
  mqtt: MQTTConfig
  objects?: {
    track?: string[]
  }
}

interface MQTTFrigateEventState {
  id: string,
  camera: string,
  frame_time: number,
  snapshot_time: number,
  label: string | null,
  sub_label: string | null,
  top_score: number,
  false_positive: boolean,
  start_time: number,
  end_time: number | null,
  score: number,
  stationary: false,
  motionless_count: number,
  position_changes: number,
  has_clip: boolean,
  has_snapshot: boolean
}

export interface MQTTFrigateEvent {
  before: MQTTFrigateEventState,
  after: MQTTFrigateEventState,
  type: 'new'| 'update' | 'end'
}
export interface MQTTOccupancy {
  cameraName: string
  trackedObject: string
  count: number
}

export type FrigateNVREventHandler = (event:MQTTFrigateEvent) => Promise<void>

export type FrigateNVROccupancyHandler = (occupancy:MQTTOccupancy) => Promise<void>