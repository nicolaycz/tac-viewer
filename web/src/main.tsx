import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Sin StrictMode: Cornerstone no tolera montar dos veces el mismo viewport
createRoot(document.getElementById('root')!).render(<App />)
