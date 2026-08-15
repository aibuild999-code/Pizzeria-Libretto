import "./globals.css";
import { DashboardShell } from "@/components/dashboard-shell";

export const metadata = { title: "Pizzeria Libretto | Operations", description: "Restaurant operations dashboard" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><DashboardShell>{children}</DashboardShell></body></html>; }
