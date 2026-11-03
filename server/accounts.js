// Synthetic firm accounts. These are not real people or real books.
export const firms = {
  northstar: {
    name: "Northstar",
    owner: {
      email: "olivia@northstarcreative.co",
      password: "ledgerly-northstar",
      name: "Olivia Martin",
    },
    clients: [
      ["Northstar Creative", "Northstar Creative LLC", "NC", "Advertising & design"],
      ["Haven Coffee Roasters", "Haven Coffee Roasters", "HC", "Food & beverage"],
      ["Brightline Labs", "Brightline Labs", "BL", "Technology"],
      ["Mason & Finch", "Mason & Finch", "MF", "Professional services"],
    ],
  },
  harbor: {
    name: "Harbor Street Advisors",
    owner: {
      email: "jordan@harborstreet.example",
      password: "ledgerly-harbor",
      name: "Jordan Hale",
    },
    clients: [
      ["Cedar & Pine Goods", "Cedar & Pine Goods", "CP", "Retail"],
      ["Lumen Field Studio", "Lumen Field Studio", "LF", "Design"],
    ],
  },
};
