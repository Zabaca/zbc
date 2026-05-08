import { natsServerModule } from '../../modules/nats-server'

export default natsServerModule.instance({
  name: 'nats',
  config: {
    appName: 'zabaca-nats',
  },
})
