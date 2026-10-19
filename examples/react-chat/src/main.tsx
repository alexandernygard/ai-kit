import { AIKitProvider } from "@alexandernygard/ai-kit-react"
import { TooltipProvider } from "@alexandernygard/components"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AIKitProvider baseUrl="/api/ai">
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </AIKitProvider>
  </StrictMode>,
)
