import { cloudflareModule } from '../../modules/cloudflare'

export default cloudflareModule.instance({
  name: 'secret-relay',
  config: {
    workdir: 'packages/secret-relay',
    accountId: '99a19e584439be0568f33aad0477372b',
    workerName: 'zbc-secret-relay',
  },
})
