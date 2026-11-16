import { EditorHost } from './editor/host';
import { Shell } from './shell/Shell';
import { ServicesContext, productionServices } from './shell/services';
import { TooltipProvider } from './ui/Tooltip';

export function App() {
  return (
    <ServicesContext.Provider value={productionServices}>
      <TooltipProvider>
        <EditorHost><Shell /></EditorHost>
      </TooltipProvider>
    </ServicesContext.Provider>
  );
}
