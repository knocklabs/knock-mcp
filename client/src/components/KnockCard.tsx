import { Box, Stack } from "@telegraph/layout";
import { Text } from "@telegraph/typography";
import { KnockLogo } from "./KnockLogo";

interface Props {
  children: React.ReactNode;
}

export function KnockCard({ children }: Props) {
  return (
    <Stack className="tgph" w="full" maxW="120" mx="auto">
      <Box
        bg="surface-1"
        shadow="2"
        w="full"
        maxW="120"
        borderRadius="4"
        border="px"
        overflow="hidden"
      >
        <Stack direction="row" align="center" gap="2" px="5" py="4" className="card-header">
          <KnockLogo />
          <Text as="span" size="3" weight="medium" color="default">
            Knock
          </Text>
        </Stack>

        <Stack direction="column" gap="5" p="6" w="full" minW="0">
          {children}
        </Stack>
      </Box>
    </Stack>
  );
}
