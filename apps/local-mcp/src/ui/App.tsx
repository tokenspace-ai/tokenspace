import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import "./index.css";
import { ApprovalDetail } from "@/ui/components/approval-detail";
import { Layout } from "@/ui/components/layout";
import { ApprovalsPage } from "@/ui/pages/approvals";
import { CredentialsPage } from "@/ui/pages/credentials";
import { InfoPage } from "@/ui/pages/info";

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Navigate to="/info" replace />} />
          <Route path="info" element={<InfoPage />} />
          <Route path="credentials" element={<CredentialsPage />} />
          <Route path="approvals" element={<ApprovalsPage />} />
          <Route path="approvals/:requestId" element={<ApprovalDetail />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
