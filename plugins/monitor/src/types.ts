export interface SystemSnapshot {
  timestamp: string
  cpu: {
    model: string
    cores: number
    usage: number           // 0-100
    perCore: number[]
    loadAvg: [number, number, number]
  }
  memory: {
    total: number           // bytes
    used: number
    free: number
    swapTotal: number
    swapUsed: number
  }
  disk: {
    partitions: Array<{
      mount: string
      total: number
      used: number
      fs: string
    }>
  }
  gpu: Array<{
    name: string
    memoryTotal: number     // MB
    memoryUsed: number
    utilization: number     // 0-100
    temperature: number     // °C
    powerDraw: number       // W
    fanSpeed: number        // 0-100%
  }>
  network: {
    interfaces: Array<{
      name: string
      ip: string
      rxBytes: number
      txBytes: number
    }>
    connections: number
  }
  processes: {
    total: number
    top: Array<{
      pid: number
      name: string
      cpu: number
      memory: number
    }>
  }
  daemon: {
    pid: number
    uptime: number
    memoryRSS: number
    heapUsed: number
    heapTotal: number
    activeSessions?: number
    loadedPlugins?: string[]
  }
}
