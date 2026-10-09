import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import OutreachPage from './pages/Outreach'
import OutreachLogin from './pages/OutreachLogin'
import OutreachSignup from './pages/OutreachSignup'
import OutreachVerify from './pages/OutreachVerify'
import OutreachJoin from './pages/OutreachJoin'

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || '/'}>
      <Routes>
        <Route path="/" element={<OutreachPage />} />
        <Route path="/login" element={<OutreachLogin />} />
        <Route path="/signup" element={<OutreachSignup />} />
        <Route path="/verify" element={<OutreachVerify />} />
        <Route path="/join" element={<OutreachJoin />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
