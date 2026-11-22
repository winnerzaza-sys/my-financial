import { createRoot } from 'react-dom/client'
import { App as AntApp, ConfigProvider, theme } from 'antd'
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
      algorithm: theme.darkAlgorithm,
      token: {
        colorPrimary: '#d6b780',
        colorInfo: '#9da9c8',
        colorSuccess: '#94b9ae',
        colorError: '#e19f9c',
        colorWarning: '#d6b780',
        colorBgBase: '#171923',
        colorBgContainer: '#1d202a',
        colorBgElevated: '#232631',
        colorText: '#ded9ce',
        colorTextSecondary: '#a2a4b2',
        colorTextPlaceholder: '#a2a4b2',
        colorTextDisabled: '#818391',
        colorBorder: '#363946',
        colorBorderSecondary: '#363946',
        fontFamily: 'Sarabun, sans-serif',
        borderRadius: 10,
        controlHeight: 42,
      },
      components: {
        Button: { primaryColor: '#171923', primaryShadow: 'none' },
        Input: { activeShadow: 'none' },
        Progress: { defaultColor: '#d6b780', remainingColor: '#363946' },
        Segmented: { trackBg: '#171923', itemSelectedBg: '#232631', itemSelectedColor: '#ded9ce' },
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
