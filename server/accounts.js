// Synthetic people. Each person has their own password. These are not real people or real books.
export const firms = {
  northstar: {
    name: "Northstar",
    owner: {
      email: "olivia@northstarcreative.co",
      password: "ledgerly-olivia",
      name: "Olivia Martin",
    },
    members: [
      {
        email: "morgan@northstarcreative.co",
        password: "ledgerly-morgan",
        name: "Morgan Hale",
        role: "manager",
      },
      {
        email: "sam@northstarcreative.co",
        password: "ledgerly-sam",
        name: "Sam Lee",
        role: "staff",
      },
      {
        email: "riley@northstarcreative.co",
        password: "ledgerly-riley",
        name: "Riley Chen",
        role: "staff",
      },
    ],
    clients: [
      ["Northstar Creative", "Northstar Creative LLC", "NC", "Advertising & design"],
      ["Haven Coffee Roasters", "Haven Coffee Roasters", "HC", "Food & beverage"],
      ["Brightline Labs", "Brightline Labs", "BL", "Technology"],
      ["Mason & Finch", "Mason & Finch", "MF", "Professional services"],
    ],
    portal: {
      email: "casey@brightline.example",
      password: "ledgerly-casey",
      name: "Casey Nguyen",
      clientName: "Brightline Labs",
    },
  },
  harbor: {
    name: "Harbor Street Advisors",
    owner: {
      email: "jordan@harborstreet.example",
      password: "ledgerly-jordan",
      name: "Jordan Hale",
    },
    clients: [
      ["Cedar & Pine Goods", "Cedar & Pine Goods", "CP", "Retail"],
      ["Lumen Field Studio", "Lumen Field Studio", "LF", "Design"],
    ],
    portal: {
      email: "rowan@cedar.example",
      password: "ledgerly-rowan",
      name: "Rowan Ellis",
      clientName: "Cedar & Pine Goods",
    },
  },
};
