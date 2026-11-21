import { createRoot } from 'react-dom/client'
import { App as AntApp, ConfigProvider } from 'antd'
import thTH from 'antd/locale/th_TH'
import dayjs from 'dayjs'
import 'dayjs/locale/th'
import 'antd/dist/reset.css'
import '@fontsource/prompt/500.css'
import '@fontsource/prompt/600.css'
import '@fontsource/sarabun/400.css'
import '@fontsource/sarabun/600.css'
import './style.css'
import { Finance } from './ui'

dayjs.locale('th')
createRoot(document.getElementById('root')!).render(
  <ConfigProvider
    locale={thTH}
    theme={{
      token: {
        colorPrimary: '#245cdb',
        colorText: '#203254',
        fontFamily: 'Sarabun, sans-serif',
        borderRadius: 12,
        controlHeight: 42,
      },
    }}
  >
    <AntApp>
      <Finance />
    </AntApp>
  </ConfigProvider>,
)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(console.error)
  })
}
