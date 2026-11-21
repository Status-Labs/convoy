// Prints the script `convoy update` runs on a VM. Used by CI to test it.
import { updateScript } from "@convoy/core";

process.stdout.write(updateScript());
