import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "@/App.tsx";
import { Toaster } from "@/components/ui/sonner";
import "@/index.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root).render(
  <StrictMode>
    {/* Dark by default, both modes supported. The storage key and the default
        must stay in step with the pre-paint script in index.html. */}
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      storageKey="cameri-theme"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
      {/* At the root, not in the shell: the project list sits outside the
          shell and reports errors too. Inside the theme provider for its colours. */}
      <Toaster />
    </ThemeProvider>
  </StrictMode>,
);
