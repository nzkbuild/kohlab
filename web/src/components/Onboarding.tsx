import { HomeScreen } from "./WorkspacesView";

/**
 * First run with no projects is the same screen as Home: the question, the
 * composer and the starter ideas. There is no separate guide to get through.
 */
export default function Onboarding() {
  return <HomeScreen />;
}
