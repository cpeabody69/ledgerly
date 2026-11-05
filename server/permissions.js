export const ROLE_LABEL = {
  owner: "Organization Owner",
  administrator: "Administrator",
  manager: "Manager",
  accountant: "Accountant",
  staff: "Staff",
  bookkeeper: "Bookkeeper",
  readonly: "Read-only employee",
};

export const EMPLOYEE_ROLES = ["administrator", "manager", "accountant", "staff", "bookkeeper", "readonly"];

export function canManageFirm(role) {
  return role === "owner" || role === "administrator";
}

export function canInviteClient(role) {
  return role === "owner" || role === "administrator" || role === "manager" || role === "accountant";
}

export function canSeeFirmTime(role) {
  return role === "owner" || role === "administrator" || role === "manager" || role === "accountant";
}

export function canApproveBills(role) {
  return role === "owner" || role === "administrator" || role === "manager" || role === "accountant";
}
